/**
 * `measure`: runs one benchmark's lifecycle through its sampler and returns its per-call
 * statistics.
 *
 * The samplers are plain synchronous loops with no `try` anywhere above the timed calls; the error
 * rules (tear down every state left alive, keep the first thrown value) live here, in their
 * caller, so a `try` never reaches the compile of a sampling loop.
 *
 * The module reads no Node builtin, so it loads in a browser page; `bun:jsc` is imported only
 * under Bun.
 */

import { isInstance, quantile, thrownMessage, timerResolutionMs } from "../utils.js";
import { type GcDuringTiming, observeCollections, type TimingWindow } from "./collections.js";
import { runningRuntime } from "./runtime.js";
import {
  CalibrationError,
  holdInFlight,
  type InFlight,
  recordWarmup,
  releaseInFlight,
  samplePerCall,
  sampleSharedState,
  startWarmup,
  WARMUP_MIN_MS,
  WARMUP_MIN_SAMPLES,
  type SamplerResult,
  type Sampling,
  type TimedMinimums,
} from "./sampler.js";

const NS_PER_MS = 1_000_000;

/** The run fails when the body's mean per call is below this multiple of the empty body's. */
const MIN_RATIO_TO_EMPTY_BODY = 1.42;

/** The time, in milliseconds, the body's timed samples span at least when `minTime` is absent. */
export const DEFAULT_MIN_TIME = 1000;

/** The fewest timed samples the body runs when `minSamples` is absent. */
export const DEFAULT_MIN_SAMPLES = 64;

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

/** Keeps the engine from inlining `fn` into its callers, as Bun's `bun:jsc` `noInline` does. */
type NoInline = typeof import("bun:jsc").noInline;

/**
 * A benchmark: how to build its state, the body to time, and how to release the state.
 *
 * A `sharedState` benchmark builds one state and times every body call on it; a `perCall` one
 * builds a fresh state for every body call. The body must be synchronous.
 */
export interface Case<State> {
  readonly kind: Lifecycle;
  readonly setup: () => State;
  readonly fn: (state: State) => unknown;
  /** Releases a state; absent means nothing to release. What it returns is read for a thenable. */
  readonly teardown?: (state: State) => unknown;
}

export interface MeasureOptions {
  /** Calls per sample to run instead of calibrating one, for the empty body and the body alike. */
  readonly callsPerSample?: number | undefined;
  /** The clock, in milliseconds; defaults to `performance.now()`. */
  readonly now?: (() => number) | undefined;
  /**
   * The time, in milliseconds, the body's timed samples span at least; defaults to
   * {@link DEFAULT_MIN_TIME}. Not validated: the caller passes a finite number of 0 or more.
   */
  readonly minTime?: number | undefined;
  /**
   * The fewest timed samples the body runs; defaults to {@link DEFAULT_MIN_SAMPLES}. Not
   * validated: the caller passes an integer of 1 or more.
   */
  readonly minSamples?: number | undefined;
}

/** Per-call statistics of the timed samples in nanoseconds, named as the report prints them. */
export interface Statistics {
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  readonly sampleCount: number;
}

/** How the body's samples were taken, named and ordered as the report prints them. */
export interface SamplingReport {
  readonly timerResolutionNs: number;
  readonly callsPerSample: number;
  /** Whether `callsPerSample` was given rather than calibrated by warmup. */
  readonly callsPerSampleFixed: boolean;
  /** The body's samples before its kept run: warmup's, plus every discarded timing attempt's. */
  readonly warmupSamples: number;
  /** How many timing attempts the body's sampler took, the kept one included. */
  readonly timingAttempts: number;
  /** The body's kept timing attempt's length on the clock, in milliseconds. */
  readonly timingMs: number;
}

/** A measurement in the shape of the report's per-process fields. */
export interface Measurement {
  readonly stats: Statistics;
  readonly sampling: SamplingReport;
  /** The body's mean per call divided by the empty body's. */
  readonly checks: { readonly ratioToEmptyBody: number };
  /** The collections seen during timing, or `null` where the runtime delivers no `gc` entries. */
  readonly gc: GcDuringTiming | null;
}

/**
 * Where a case failed: `setup`, `fn` or `teardown` threw, or its first call returned a thenable or
 * a value whose `then` property throws when read; `optimized-away`, the body is too close to the
 * empty body to tell apart; `calibration`, a count passed the cap or a third timing attempt was
 * discarded; `child`, the runtime lacks what measuring needs.
 */
export type Phase = "setup" | "fn" | "teardown" | "optimized-away" | "calibration" | "child";

/**
 * A failure of `measure`: the phase it failed in, and as `cause` the value a callback, the loader or
 * the collector threw, or for `optimized-away` and a missing collector the `Error` `measure`
 * built.
 */
export class MeasureError extends Error {
  override name = "MeasureError";
  readonly phase: Phase;
  /**
   * The teardown's failure, in phase `teardown`, when the cleanup that tore the state down after
   * this failure threw too; `null` when that teardown returned or no cleanup ran.
   */
  readonly teardownError: MeasureError | null;

  /**
   * Builds the error, its message the string form of the cause's own when the cause is an `Error`,
   * the cause's string form otherwise, or a placeholder for a value that has none.
   *
   * @param phase - Where the case failed.
   * @param cause - The value that was thrown, or the `Error` built for a failure of `measure`'s own;
   *   kept as it is.
   * @param teardownError - The failure of the cleanup's teardown after this failure, or `null`.
   */
  constructor(phase: Phase, cause: unknown, teardownError: MeasureError | null = null) {
    super(thrownMessage(cause), { cause });
    this.phase = phase;
    this.teardownError = teardownError;
  }
}

/** What the body's sampler is handed: the empty run's sampling plus `minTime` and `minSamples`. */
interface BodySampling extends Sampling, TimedMinimums {}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * The default clock.
 *
 * Called on `performance`, since an unbound `now` throws on Node.
 *
 * @returns The current high-resolution time, in milliseconds.
 */
function performanceNow(): number {
  return performance.now();
}

/**
 * Measures a benchmark: the body, then an empty body in the benchmark's own lifecycle.
 *
 * Nothing samples or collects before the body's run. On Node, another function run through the
 * sampling loops, or a collection before the body's setup, changes how the engine compiles the
 * body: some bodies read up to 78 % slow.
 *
 * @param benchmark - The benchmark to measure.
 * @param options - A fixed count, a clock to read, and the `minTime` and
 *   `minSamples` the body's timing attempts must pass, {@link DEFAULT_MIN_TIME} and
 *   {@link DEFAULT_MIN_SAMPLES} when absent; the empty body always takes the fixed count of timed
 *   samples {@link sampleEmpty} runs.
 * @returns The measurement in the report's shape: the body's per-call statistics in nanoseconds,
 *   how they were taken, its ratio to the empty body and the collections seen during timing.
 * @throws MeasureError in phase `child` when no garbage collector is exposed, or when Bun is
 *   running but `bun:jsc` cannot be loaded, with the loader's value as cause, before anything runs;
 *   and when the forced GC throws, with the collector's value as cause, after every state left
 *   alive is torn down.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback's first call returns
 *   a thenable, or a value whose `then` read throws, with the read's error as cause, after every
 *   state left alive is torn down; a per-call case's later calls are not checked.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback throws, with the
 *   thrown value unchanged as cause, after every state left alive is torn down; a teardown error
 *   during that cleanup is attached to the error as its `teardownError`, and a per-call state whose
 *   teardown threw is not torn down again.
 * @throws MeasureError in phase `calibration` when warmup's or a grown count would pass the cap (the
 *   body's or the empty run's warmup count, or a count grown after a discarded body run), or when a
 *   sharedState body's third timing attempt is discarded too, naming the count a fourth would need.
 * @throws MeasureError in phase `optimized-away` when the body's mean per call is below
 *   {@link MIN_RATIO_TO_EMPTY_BODY} times the empty body's, naming both.
 */
export async function measure<State>(
  benchmark: Case<State>,
  options: MeasureOptions = {},
): Promise<Measurement> {
  const gc = exposedGc();
  const noInline = await runtimeNoInline();
  noInline?.(benchmark.fn);
  noInline?.(empty);

  const now = options.now ?? performanceNow;
  const resolutionMs = timerResolutionMs(now);
  const timing: TimingWindow = { startMs: 0, endMs: 0 };
  const sampling: Sampling = {
    now,
    resolutionMs,
    callsPerSample: options.callsPerSample,
    collect: () => {
      collectGarbage(gc);
      timing.startMs = performance.now();
    },
  };

  const bodySampling: BodySampling = {
    ...sampling,
    minTime: options.minTime ?? DEFAULT_MIN_TIME,
    minSamples: options.minSamples ?? DEFAULT_MIN_SAMPLES,
  };

  const observer = observeCollections();
  let run: SamplerResult;
  let gcDuringTiming: GcDuringTiming | undefined;
  try {
    run =
      benchmark.kind === "sharedState"
        ? measureSharedState(benchmark, bodySampling, timing)
        : measurePerCall(benchmark, bodySampling, timing);
    if (observer !== undefined) {
      gcDuringTiming = await observer.during(timing);
    }
  } finally {
    observer?.disconnect();
  }

  const stats = summarize(run.spans, run.sampleCount, run.callsPerSample);
  // The body's timing window has closed, so the empty run's collection only collects.
  const ratioToEmptyBody = checkedRatioToEmptyBody(stats.mean, benchmark.kind, {
    ...sampling,
    collect: () => {
      collectGarbage(gc);
    },
  });
  return {
    stats,
    sampling: {
      timerResolutionNs: resolutionMs * NS_PER_MS,
      callsPerSample: run.callsPerSample,
      callsPerSampleFixed: options.callsPerSample !== undefined,
      warmupSamples: run.warmupSamples,
      timingAttempts: run.timingAttempts,
      timingMs: run.timingMs,
    },
    checks: { ratioToEmptyBody },
    gc: gcDuringTiming ?? null,
  };
}

/**
 * Times the empty body in the benchmark's own lifecycle and divides the body's mean by its mean.
 *
 * @param bodyMeanNs - The body's mean per call, in nanoseconds.
 * @param kind - The benchmark's lifecycle.
 * @param sampling - The clock, its resolution, the forced GC, and the fixed count if one was given.
 * @returns The body's mean per call divided by the empty body's.
 * @throws MeasureError in phase `calibration` when the empty run's warmup count would pass its cap.
 * @throws MeasureError in phase `child` when the forced GC throws.
 * @throws MeasureError in phase `optimized-away` when the ratio is below
 *   {@link MIN_RATIO_TO_EMPTY_BODY}, naming both means.
 */
function checkedRatioToEmptyBody(bodyMeanNs: number, kind: Lifecycle, sampling: Sampling): number {
  let emptyRun: EmptyResult;
  try {
    emptyRun = sampleEmpty({ kind, ...sampling });
  } catch (error) {
    // The empty body is repset's own, so `failedIn` never falls back to `child`: it keeps the forced
    // GC's MeasureError and maps the cap's CalibrationError to `calibration`.
    throw failedIn("child", error);
  }
  const emptyMeanNs = summarize(emptyRun.spans, emptyRun.sampleCount, emptyRun.callsPerSample).mean;
  const ratio = bodyMeanNs / emptyMeanNs;
  if (!(ratio >= MIN_RATIO_TO_EMPTY_BODY)) {
    throw new MeasureError(
      "optimized-away",
      new Error(
        `the body reads ${formatNs(bodyMeanNs)} ns per call, under ${String(MIN_RATIO_TO_EMPTY_BODY)} times the empty body's ${formatNs(emptyMeanNs)} ns: the benchmark times too little work to tell apart from the loop`,
      ),
    );
  }
  return ratio;
}

/**
 * Runs the exposed collector, outside every timed sample: a minor collection, then a full one.
 *
 * On Node, a full collection that finds the benchmark's state still in the young generation
 * promotes it straight to the old one, often spread over many pages, and a body that walks that
 * state then reads up to 2.3 times slower in that process. The minor collection first compacts the
 * state, so the full one moves it as a block.
 *
 * @param gc - The collector `measure` read from the runtime.
 * @throws MeasureError in phase `child` when the collector throws, with its value as cause.
 */
function collectGarbage(gc: NonNullable<typeof globalThis.gc>): void {
  try {
    gc({ type: "minor" });
    gc();
  } catch (error) {
    throw new MeasureError("child", error);
  }
}

/**
 * Keeps a `MeasureError` already raised as it is, and wraps any other thrown value.
 *
 * @param phase - Where the case failed when `error` is neither a `MeasureError` nor a
 *   `CalibrationError`.
 * @param error - The thrown value.
 * @param teardownError - The failure of the cleanup's teardown after `error`, or `null`.
 * @returns `error` itself when it is a `MeasureError` and `teardownError` is `null`, or a copy of
 *   its phase and cause carrying `teardownError`; a `MeasureError` in phase `calibration` when it is
 *   a `CalibrationError`; otherwise a `MeasureError` in `phase`. The wrapped ones have `error` as
 *   cause and carry `teardownError`.
 */
function failedIn(
  phase: Phase,
  error: unknown,
  teardownError: MeasureError | null = null,
): MeasureError {
  if (isInstance(error, MeasureError)) {
    return teardownError === null
      ? error
      : new MeasureError(error.phase, error.cause, teardownError);
  }
  return new MeasureError(
    isInstance(error, CalibrationError) ? "calibration" : phase,
    error,
    teardownError,
  );
}

/**
 * Reads the collector `measure` runs between samples.
 *
 * @returns The collector, which exists only when the process starts with `--expose-gc`.
 * @throws MeasureError in phase `child` when no collector is exposed.
 */
export function exposedGc(): NonNullable<typeof globalThis.gc> {
  const gc = globalThis.gc;
  if (typeof gc !== "function") {
    throw new MeasureError(
      "child",
      new Error("measuring requires an exposed gc: run node or bun with --expose-gc"),
    );
  }
  return gc;
}

/**
 * Loads the running runtime's `noInline`, importing `bun:jsc` only under Bun.
 *
 * @returns Bun's `noInline`, or `undefined` on any other runtime.
 * @throws MeasureError in phase `child` when Bun is running but `bun:jsc` cannot be loaded,
 *   with whatever the loader rejected with as cause.
 */
export async function runtimeNoInline(): Promise<NoInline | undefined> {
  if (runningRuntime() !== "bun") return undefined;
  try {
    const { noInline } = await import("bun:jsc");
    return noInline;
  } catch (error) {
    throw new MeasureError("child", error);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle runners
// ---------------------------------------------------------------------------

/** The teardown of a benchmark that gives none. */
function keep(): void {
  // A state without a teardown is left to the garbage collector.
}

/**
 * Builds one state of a benchmark, checks the setup and the body are synchronous on it, hands it
 * to `use`, then tears it down and checks the teardown is synchronous.
 *
 * Every `try` of the shared-state lifecycle lives here, so `use` holds none above its timed calls.
 *
 * @param benchmark - The benchmark whose `setup`, `fn` and `teardown` run.
 * @param use - Runs on the state once the body's first call has returned without a thenable.
 * @returns What `use` returned.
 * @throws MeasureError in phase `setup` when `setup` throws, before anything else runs.
 * @throws MeasureError in phase `setup` when `setup` returns a thenable or a value whose `then` read
 *   throws, and in phase `fn` when the body throws or its first call returns either, after teardown
 *   ran; a teardown error, thenable or `then` read error then is attached to the error as its
 *   `teardownError`.
 * @throws MeasureError in phase `calibration` when `use` throws a `CalibrationError`, in the phase
 *   of any `MeasureError` it throws, otherwise in phase `fn`, after teardown ran; a teardown error,
 *   thenable or `then` read error then is attached to the error as its `teardownError`.
 * @throws MeasureError in phase `teardown` when `teardown` throws, returns a thenable or returns a
 *   value whose `then` read throws, and the body succeeded.
 */
export function withCaseState<State, Result>(
  benchmark: Case<State>,
  use: (state: State) => Result,
): Result {
  const { setup, fn } = benchmark;
  const teardown = benchmark.teardown ?? keep;
  let state: State;
  try {
    state = setup();
  } catch (error) {
    throw new MeasureError("setup", error);
  }
  let result: Result;
  try {
    requireSynchronous(state, "setup");
    requireSynchronous(fn(state), "fn");
    result = use(state);
  } catch (error) {
    throw failedIn("fn", error, tearDownCatching(teardown, state));
  }
  const teardownFailure = tearDownCatching(teardown, state);
  if (teardownFailure !== null) throw teardownFailure;
  return result;
}

/**
 * Runs a shared-state benchmark: builds one state, checks the setup and the body are synchronous,
 * samples it, then tears the state down and checks the teardown is synchronous.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its resolution, the forced GC, the fixed count if one was given, and
 *   the `minTime` and `minSamples` the timing attempts must pass.
 * @param timing - Receives the end of each timing attempt's samples, before the sampler checks the
 *   run; the forced GC before each run records their start.
 * @returns What the body's sampler returned.
 * @throws MeasureError in phase `setup` when `setup` throws, before anything else runs.
 * @throws MeasureError in phase `setup` when `setup` returns a thenable or a value whose `then` read
 *   throws, and in phase `fn` when the body throws or its first call returns either, after teardown
 *   ran; a teardown error, thenable or `then` read error then is attached to the error as its
 *   `teardownError`.
 * @throws MeasureError in phase `calibration` when the sampler refuses a count or a fourth run, and in
 *   phase `child` when the forced GC throws, after teardown ran; a teardown error, thenable or
 *   `then` read error then is attached to the error as its `teardownError`.
 * @throws MeasureError in phase `teardown` when `teardown` throws, returns a thenable or returns a
 *   value whose `then` read throws, and the body succeeded.
 */
function measureSharedState<State>(
  benchmark: Case<State>,
  sampling: BodySampling,
  timing: TimingWindow,
): SamplerResult {
  return withCaseState(benchmark, (state) =>
    sampleSharedState({
      ...sampling,
      fn: benchmark.fn,
      state,
      afterTiming: () => {
        timing.endMs = performance.now();
      },
    }),
  );
}

/**
 * Runs a per-call benchmark: checks the setup, the body and the teardown are synchronous on one
 * built state, then samples it, tearing down the state left alive when anything throws. Only that
 * first call of each is checked: the sampled calls reach the sampler unchanged.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its resolution, the forced GC, the fixed count if one was given, and
 *   the `minTime` and `minSamples` the timing attempts must pass.
 * @param timing - Receives the end of the timed samples; the forced GC records their start.
 * @returns What the body's sampler returned.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback throws or its first
 *   call returns a thenable or a value whose `then` read throws, `calibration` when the sampler
 *   refuses a count, and `child` when the forced GC throws, after the state built and not torn
 *   down, if any, is torn down, save one whose teardown threw or returned either; a teardown error,
 *   thenable or `then` read error during that cleanup is attached to the error as its
 *   `teardownError`.
 */
function measurePerCall<State>(
  benchmark: Case<State>,
  sampling: BodySampling,
  timing: TimingWindow,
): SamplerResult {
  const { setup, fn, teardown: caseTeardown } = benchmark;
  const teardown = caseTeardown ?? keep;
  // Set only while the case's teardown runs: a throw that leaves it set came from the teardown.
  // The wrapper holds no `try` and keeps no reference to the state, and runs outside every body
  // call's pair of clock reads: only the wall time warmup and timing count includes it.
  let tearingDown = false;
  const trackedTeardown =
    caseTeardown === undefined
      ? keep
      : (state: State): unknown => {
          tearingDown = true;
          const returned = caseTeardown(state);
          tearingDown = false;
          return returned;
        };
  const inFlight: InFlight<State> = { held: false, state: undefined };
  try {
    const firstState = setup();
    holdInFlight(inFlight, firstState);
    requireSynchronous(firstState, "setup");
    requireSynchronous(fn(firstState), "fn");
    const returned: unknown = trackedTeardown(firstState);
    releaseInFlight(inFlight);
    requireSynchronous(returned, "teardown");
    const run = samplePerCall({ ...sampling, setup, fn, teardown: trackedTeardown, inFlight });
    timing.endMs = performance.now();
    return run;
  } catch (error) {
    const phase = perCallPhase(inFlight.held, tearingDown);
    // A state whose teardown threw is left alone rather than torn down a second time.
    const teardownError =
      holds(inFlight) && phase !== "teardown" ? tearDownCatching(teardown, inFlight.state) : null;
    throw failedIn(phase, error, teardownError);
  }
}

/**
 * Whether `inFlight` holds a state, narrowing `state` to it: while `held` is set, the sampler
 * keeps `state` the one in flight, whatever its value.
 *
 * @param inFlight - The holder the per-call run writes.
 * @returns `held`.
 */
function holds<State>(inFlight: InFlight<State>): inFlight is { held: true; state: State } {
  return inFlight.held;
}

/**
 * Names the phase a per-call case failed in from the sampler's state when the error reached
 * `measure`, for {@link failedIn} to fall back to: it maps the sampler's `CalibrationError` itself.
 *
 * @param held - Whether a state was built and not torn down.
 * @param tearingDown - Whether the case's teardown had started and not returned.
 * @returns `setup` with no state in flight, `teardown` while one was being torn down, and `fn` for
 *   the rest.
 */
function perCallPhase(held: boolean, tearingDown: boolean): Phase {
  if (!held) return "setup";
  return tearingDown ? "teardown" : "fn";
}

/** A case callback whose first call `measure` checks for a thenable. */
type Callback = "setup" | "fn" | "teardown";

/**
 * Fails a callback whose call returned a thenable: the samplers time calls, not settled promises,
 * and a setup or teardown that settles later would run on the clock.
 *
 * @param returned - What the callback's call returned.
 * @param callback - The callback that returned it, which is also the phase it fails in.
 * @throws MeasureError in phase `callback` when `returned` has a callable `then`, or when reading
 *   its `then` throws, with the read's error as cause.
 */
function requireSynchronous(returned: unknown, callback: Callback): void {
  const failure = thenableFailure(returned, callback);
  if (failure !== null) throw failure;
}

/**
 * Checks a callback's return value for a thenable.
 *
 * Before failing, it settles the thenable into a promise whose rejection is handled, so that a
 * rejected thenable raises no unhandled rejection, which on Node ends the measuring process before
 * it reports the failure.
 *
 * @param returned - What the callback's call returned.
 * @param callback - The callback that returned it, which is also the phase it fails in.
 * @returns A `MeasureError` in phase `callback` when `returned` has a callable `then`, or with the
 *   read's error as cause when reading its `then` throws (a getter or a proxy trap); `null`
 *   otherwise. It never throws, so a cleanup that calls it keeps the error already in flight.
 */
function thenableFailure(returned: unknown, callback: Callback): MeasureError | null {
  if ((typeof returned !== "object" && typeof returned !== "function") || returned === null) {
    return null;
  }
  let then: unknown;
  try {
    then = Reflect.get(returned, "then");
  } catch (error) {
    return new MeasureError(callback, error);
  }
  if (typeof then !== "function") return null;
  // A promise's resolve function never throws: a `then` getter or call that throws rejects the
  // new promise instead, so the thenable failure below is the one that surfaces.
  new Promise((resolve) => {
    resolve(returned);
  }).catch(() => undefined);
  return new MeasureError(
    callback,
    new Error(`benchmark ${callback} must be synchronous: it returned a thenable`),
  );
}

/**
 * Tears `state` down and hands back its failure instead of throwing it. On the success path the
 * caller throws that failure; while an error is already in flight, that error wins, so the caller
 * attaches the teardown's failure to it rather than letting it replace the error, which a `finally`
 * would do.
 *
 * @param teardown - The benchmark's teardown.
 * @param state - The state to release.
 * @returns A `MeasureError` in phase `teardown` with the teardown's thrown value as cause, whatever
 *   that value, `null` included, or for a teardown that returned a thenable or a value whose `then`
 *   read throws; `null` when the teardown returned anything else.
 */
function tearDownCatching<State>(
  teardown: (state: State) => unknown,
  state: State,
): MeasureError | null {
  let returned: unknown;
  try {
    returned = teardown(state);
  } catch (error) {
    return new MeasureError("teardown", error);
  }
  return thenableFailure(returned, "teardown");
}

// ---------------------------------------------------------------------------
// The empty run
// ---------------------------------------------------------------------------

// The empty run times a body that does nothing, in a benchmark's own lifecycle, so `measure` can
// tell a body from the loop around it. Spans are in milliseconds.
//
// Its loops are functions of their own, never `sampleSharedState` or `samplePerCall`: on Node, a
// sampling loop that has already run the body reads the empty body about six times slow. The loops
// keep the shape of the body's samplers, so they time what the body's loops cost.

/** The empty run's timed samples, whatever `minTime` and `minSamples` the body ran on. */
const TIMED_SAMPLES = 64;

/** The empty body the body's reading is compared against. */
function empty(): void {
  // Times the sampling loop alone.
}

type EmptyResult = Pick<SamplerResult, "spans" | "sampleCount" | "callsPerSample">;

/** How a benchmark builds the state its body runs on: one shared by every call, or one per call. */
type Lifecycle = "sharedState" | "perCall";

interface EmptyOptions extends Sampling {
  /** `sharedState` times batched calls between one pair of clock reads; `perCall` sums per-call spans. */
  readonly kind: Lifecycle;
}

// The empty body is reached through `fn`, as the samplers reach theirs, so these loops compile
// as theirs do.
interface Timed {
  readonly now: () => number;
  readonly fn: () => unknown;
}

/** Holds what the batched loop's last empty call returned, as the shared-state sampler does. */
const consumed: { value: unknown } = { value: undefined };

/**
 * Times `count` consecutive empty calls between one pair of clock reads, then keeps what the last
 * call returned, as a shared-state sample does.
 *
 * @param timed - The clock and the empty body.
 * @param count - Calls in this sample.
 * @returns The span, in milliseconds.
 */
function batched(timed: Timed, count: number): number {
  const { now, fn } = timed;
  let last: unknown;
  const started = now();
  for (let call = 0; call < count; call++) {
    last = fn();
  }
  const spanMs = now() - started;
  consumed.value = last;
  return spanMs;
}

/**
 * Times each of `count` empty calls between its own pair of clock reads and sums the spans, as a
 * per-call sample does.
 *
 * @param timed - The clock and the empty body.
 * @param count - Calls in this sample.
 * @returns The summed span, in milliseconds.
 */
function summed(timed: Timed, count: number): number {
  const { now, fn } = timed;
  let total = 0;
  for (let call = 0; call < count; call++) {
    const started = now();
    fn();
    total += now() - started;
  }
  return total;
}

/**
 * Times the empty body: warmup samples until both {@link WARMUP_MIN_MS} ms on the clock and
 * {@link WARMUP_MIN_SAMPLES} samples have passed, calibrating the count unless one is fixed, then
 * one collection, then {@link TIMED_SAMPLES} timed samples.
 *
 * The time minimum keeps the timed samples on the code the engine settles on: Bun can compile the
 * empty loop partway through a shorter warmup, and the timed samples then read two speeds.
 *
 * @param options - The lifecycle to time it in, the clock, its resolution, the forced GC, and the
 *   fixed count if one was given.
 * @returns The {@link TIMED_SAMPLES} timed spans and the calls per sample they ran.
 * @throws Whatever `collect` throws, and CalibrationError when warmup's count would pass
 *   `ceil(200 × resolution / 0.1 ns)`, naming the count asked for and the cap.
 */
function sampleEmpty(options: EmptyOptions): EmptyResult {
  const { kind, now, resolutionMs, collect, callsPerSample } = options;
  const span = kind === "sharedState" ? batched : summed;
  const timed: Timed = { now, fn: empty };
  const progress = startWarmup(resolutionMs, callsPerSample);
  const started = now();
  while (progress.samples < WARMUP_MIN_SAMPLES || now() - started < WARMUP_MIN_MS) {
    recordWarmup(progress, span(timed, progress.count));
  }
  const count = progress.count;
  const spans = new Float64Array(TIMED_SAMPLES);
  collect();
  for (let stored = 0; stored < spans.length; stored++) {
    spans[stored] = span(timed, count);
  }
  return { spans, sampleCount: spans.length, callsPerSample: count };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Summarizes a sampler's timed spans as per-call statistics in nanoseconds.
 *
 * The spans may be stored in any order; the store itself is left untouched.
 *
 * @param spansMs - The sampler's sample buffer: each timed sample's span in milliseconds, for
 *   `callsPerSample` body calls. Only its first `stored` slots are read.
 * @param stored - How many spans the sampler stored.
 * @param callsPerSample - How many body calls each span timed.
 * @returns The per-call statistics of the stored spans.
 * @throws RangeError when no span was stored.
 */
export function summarize(
  spansMs: Float64Array,
  stored: number,
  callsPerSample: number,
): Statistics {
  const sorted = spansMs
    .subarray(0, stored)
    .toSorted()
    .map((spanMs) => (spanMs / callsPerSample) * NS_PER_MS);
  const total = sorted.reduce((sum, time) => sum + time, 0);
  return {
    min: quantile(sorted, 0),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p99: quantile(sorted, 0.99),
    max: quantile(sorted, 1),
    mean: total / sorted.length,
    sampleCount: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a per-call time for an error message, to at most three decimals.
 *
 * @param ns - The time, in nanoseconds.
 * @returns The time as a plain decimal.
 */
function formatNs(ns: number): string {
  return String(Number(ns.toFixed(3)));
}
