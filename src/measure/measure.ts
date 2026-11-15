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

import { performanceNow, timerResolutionMs } from "../utils.js";
import { empty, type EmptyResult, type Lifecycle, sampleEmpty } from "./empty.js";
import { type InFlight, keep, samplePerCall } from "./per-call.js";
import { runningRuntime } from "./runtime.js";
import {
  CalibrationError,
  sampleSharedState,
  type SamplerResult,
  type Sampling,
  type TimedMinimums,
} from "./shared-state.js";

const NS_PER_MS = 1_000_000;

/** The run fails when the body's mean per call is below this multiple of the empty body's. */
const MIN_RATIO_TO_EMPTY_BODY = 1.42;
const DIAG: unknown[] = [];

/** `detail.kind` of a Node `gc` performance entry for a scavenge (`NODE_PERFORMANCE_GC_MINOR`). */
const GC_MINOR = 1;

/** `detail.kind` of a Node `gc` performance entry for a full mark-compact (`NODE_PERFORMANCE_GC_MAJOR`). */
const GC_MAJOR = 4;

/** The time, in milliseconds, the body's timed samples span at least when `minTime` is absent. */
const DEFAULT_TIME_MS = 1000;

/** The fewest timed samples the body runs when `minSamples` is absent. */
const DEFAULT_SAMPLES = 64;

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

/** Keeps the engine from inlining `fn` into its callers, as Bun's `bun:jsc` `noInline` does. */
export type NoInline = typeof import("bun:jsc").noInline;

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
  /** Releases a state; absent means nothing to release. */
  readonly teardown?: (state: State) => void;
}

export interface MeasureOptions {
  /** Calls per sample to run instead of calibrating one, for the empty body and the body alike. */
  readonly callsPerSample?: number;
  /** Replaces the runtime's `noInline`: `bun:jsc`'s under Bun, none on Node. */
  readonly noInline?: NoInline;
  /** The clock, in milliseconds; defaults to `performance.now()`. */
  readonly now?: () => number;
  /**
   * The time, in milliseconds, the body's timed samples span at least; defaults to 1000. Not
   * validated: the caller passes a finite number of 0 or more.
   */
  readonly minTime?: number;
  /**
   * The fewest timed samples the body runs; defaults to 64. Not validated: the caller passes an
   * integer of 1 or more.
   */
  readonly minSamples?: number;
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

/** The collections a `gc` performance observer saw while the body's samples were timed. */
export interface GcDuringTiming {
  readonly count: number;
  readonly minor: number;
  readonly major: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface Measurement extends Statistics {
  readonly timerResolutionNs: number;
  readonly callsPerSample: number;
  /** Whether `callsPerSample` was given rather than calibrated by warmup. */
  readonly callsPerSampleFixed: boolean;
  /** Whether a collection ran between warmup and timing. */
  readonly collected: boolean;
  /** The body's mean per call divided by the empty body's. */
  readonly ratioToEmptyBody: number;
  /** Present only where the runtime delivers `gc` performance entries, as Node does. */
  readonly gcDuringTiming?: GcDuringTiming;
  /** How many timing attempts the body's sampler took, the kept one included. */
  readonly timingAttempts: number;
  /** The body's samples before its kept run: warmup's, plus every discarded timing attempt's. */
  readonly warmupSamples: number;
  /** The body's kept timing attempt's length on the clock, in milliseconds. */
  readonly timingMs: number;
}

/**
 * Where a case failed: `setup`, `fn` or `teardown` threw (`fn` also for a first call that returned
 * a thenable); `optimized-away`, the body is too close to the empty body to tell apart; `calibration`, a count
 * passed the cap or a third timing attempt was discarded; `child`, the runtime lacks what measuring
 * needs.
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
   * Builds the error, its message the cause's own when the cause is an `Error`, its string form
   * otherwise, or a placeholder for a value that has none.
   *
   * @param phase - Where the case failed.
   * @param cause - The value that was thrown, or the `Error` built for a failure of `measure`'s own;
   *   kept as it is.
   */
  constructor(phase: Phase, cause: unknown) {
    super(cause instanceof Error ? cause.message : stringForm(cause), { cause });
    this.phase = phase;
  }
}

/**
 * Reads a thrown value's string form for an error message, without letting the conversion throw in
 * place of the failure it describes.
 *
 * @param value - The thrown value.
 * @returns `String(value)`, or `"a value with no string form"` when that conversion throws, as it
 *   does for a null-prototype object.
 */
function stringForm(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "a value with no string form";
  }
}

/** What the body's sampler is handed: the empty run's sampling plus `minTime` and `minSamples`. */
interface BodySampling extends Sampling, TimedMinimums {}

/** The real-time bounds, on the `performance.now()` timeline, of the body's timed samples. */
interface TimingWindow {
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Measures a benchmark: the body, then an empty body in the benchmark's own lifecycle.
 *
 * Nothing samples or collects before the body's run. On Node, another function run through the
 * sampling loops, or a collection before the body's setup, changes how the engine compiles the
 * body: some bodies read up to 78 % slow.
 *
 * @param benchmark - The benchmark to measure.
 * @param options - A fixed count, an injected `noInline`, a clock to read, and the `minTime` and
 *   `minSamples` the body's timing attempts must pass, 1000 ms and 64 when absent; the empty body
 *   always takes 64 timed samples.
 * @returns The body's per-call statistics in nanoseconds and how they were taken.
 * @throws MeasureError in phase `child` when no garbage collector is exposed, or when Bun is
 *   running but `bun:jsc` cannot be loaded, with the loader's value as cause, before anything runs;
 *   and when the forced GC throws, with the collector's value as cause, after every state left
 *   alive is torn down.
 * @throws MeasureError in phase `fn` when the body's first call returns a thenable, after its
 *   state is torn down.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback throws, with the
 *   thrown value unchanged as cause, after every state left alive is torn down; a teardown error
 *   during that cleanup is discarded, and a per-call state whose teardown threw is not torn down
 *   again.
 * @throws MeasureError in phase `calibration` when warmup's or a grown count would pass the cap (the
 *   body's or the empty run's warmup count, or a count grown after a discarded body run), or when a
 *   sharedState body's third timing attempt is discarded too, naming the count a fourth would need.
 * @throws MeasureError in phase `optimized-away` when the body's mean per call is below 1.42 times the empty
 *   body's, naming both.
 */
export async function measure<State>(
  benchmark: Case<State>,
  options: MeasureOptions = {},
): Promise<Measurement> {
  const gc = exposedGc();
  const noInline = options.noInline ?? (await runtimeNoInline());
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

  const bodySampling: BodySampling = { ...sampling, ...timedMinimums(options) };

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

  const statistics = summarize(run.spans, run.sampleCount, run.callsPerSample);
  // The body's timing window has closed, so the empty run's collection only collects.
  const ratioToEmptyBody = checkedRatioToEmptyBody(statistics.mean, benchmark.kind, {
    ...sampling,
    collect: () => {
      collectGarbage(gc);
    },
  });
  return {
    ...statistics,
    timerResolutionNs: resolutionMs * NS_PER_MS,
    callsPerSample: run.callsPerSample,
    callsPerSampleFixed: options.callsPerSample !== undefined,
    collected: true,
    ratioToEmptyBody,
    ...(gcDuringTiming === undefined ? {} : { gcDuringTiming }),
    timingAttempts: run.timingAttempts,
    warmupSamples: run.warmupSamples,
    timingMs: run.timingMs,
  };
}

/**
 * The `minTime` and `minSamples` the body's timing attempts must pass.
 *
 * @param options - The options `measure` was given.
 * @returns The given `minTime` and `minSamples`, 1000 ms and 64 when absent.
 */
function timedMinimums(options: MeasureOptions): TimedMinimums {
  return {
    minTime: options.minTime ?? DEFAULT_TIME_MS,
    minSamples: options.minSamples ?? DEFAULT_SAMPLES,
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
 * @throws MeasureError in phase `optimized-away` when the ratio is below 1.42, naming both means.
 */
function checkedRatioToEmptyBody(bodyMeanNs: number, kind: Lifecycle, sampling: Sampling): number {
  let emptyRun: EmptyResult;
  try {
    emptyRun = sampleEmpty({ kind, ...sampling });
  } catch (error) {
    // The empty body is repset's own: past the cap, only the forced GC is left to throw, and it
    // throws a MeasureError of its own.
    throw failedIn("child", error);
  }
  const emptyMeanNs = summarize(emptyRun.spans, emptyRun.sampleCount, emptyRun.callsPerSample).mean;
  const ratio = bodyMeanNs / emptyMeanNs;
  if (!(ratio >= MIN_RATIO_TO_EMPTY_BODY)) {
    throw new MeasureError(
      "optimized-away",
      new Error(
        `the body reads ${formatNs(bodyMeanNs)} ns per call, under ${String(MIN_RATIO_TO_EMPTY_BODY)} times the empty body's ${formatNs(emptyMeanNs)} ns: the benchmark times too little work to tell apart from the loop DIAG ${JSON.stringify({ resolutionMs: sampling.resolutionMs, runs: DIAG, emptySpansMs: [...emptyRun.spans] })}`,
      ),
    );
  }
  return ratio;
}

/**
 * Runs the exposed collector, outside every timed sample.
 *
 * @param gc - The collector `measure` read from the runtime.
 * @throws MeasureError in phase `child` when the collector throws, with its value as cause.
 */
function collectGarbage(gc: NonNullable<typeof globalThis.gc>): void {
  try {
    gc();
  } catch (error) {
    throw new MeasureError("child", error);
  }
}

/**
 * Keeps a `MeasureError` a collection already raised, and wraps any other thrown value.
 *
 * @param phase - Where the case failed when `error` is neither a `MeasureError` nor a
 *   `CalibrationError`.
 * @param error - The thrown value.
 * @returns `error` itself when it is a `MeasureError`; a `MeasureError` in phase `calibration` when
 *   it is a `CalibrationError`; otherwise a `MeasureError` in `phase`. The wrapped ones have `error`
 *   as cause.
 */
function failedIn(phase: Phase, error: unknown): MeasureError {
  if (error instanceof MeasureError) return error;
  return new MeasureError(error instanceof CalibrationError ? "calibration" : phase, error);
}

/**
 * Reads the garbage collector the runtime exposes.
 *
 * @returns `globalThis.gc`.
 * @throws MeasureError in phase `child` when no collector is exposed.
 */
function exposedGc(): NonNullable<typeof globalThis.gc> {
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
async function runtimeNoInline(): Promise<NoInline | undefined> {
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

/**
 * Runs a shared-state benchmark: builds one state, checks the body is synchronous, samples it,
 * then tears the state down.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its resolution, the forced GC, the fixed count if one was given, and the
 *   `minTime` and `minSamples` the timing attempts must pass.
 * @param timing - Receives the end of each timing attempt's samples, before the sampler checks the run;
 *   the forced GC before each run records their start.
 * @returns What the body's sampler returned.
 * @throws MeasureError in phase `setup` when `setup` throws, before anything else runs.
 * @throws MeasureError in phase `fn` when the body throws or its first call returns a thenable,
 *   after teardown ran; a teardown error then is discarded.
 * @throws MeasureError in phase `calibration` when the sampler refuses a count or a fourth run, and in
 *   phase `child` when the forced GC throws, after teardown ran; a teardown error then is
 *   discarded.
 * @throws MeasureError in phase `teardown` when `teardown` throws and the body succeeded.
 */
function measureSharedState<State>(
  benchmark: Case<State>,
  sampling: BodySampling,
  timing: TimingWindow,
): SamplerResult {
  const { setup, fn } = benchmark;
  const teardown = benchmark.teardown ?? keep;
  let state: State;
  try {
    state = setup();
  } catch (error) {
    throw new MeasureError("setup", error);
  }
  let run: SamplerResult;
  try {
    requireSynchronous(fn(state));
    run = sampleSharedState({
      ...sampling,
      fn,
      state,
      afterTiming: () => {
        timing.endMs = performance.now();
      },
    });
  } catch (error) {
    tearDownDiscarding(teardown, state);
    throw failedIn("fn", error);
  }
  try {
    teardown(state);
  } catch (error) {
    throw new MeasureError("teardown", error);
  }
  return run;
}

/**
 * Runs a per-call benchmark: checks the body is synchronous on one built state, then samples it,
 * tearing down the state left alive when anything throws.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its resolution, the forced GC, the fixed count if one was given, and the
 *   `minTime` and `minSamples` the timing attempts must pass.
 * @param timing - Receives the end of the timed samples; the forced GC records their start.
 * @returns What the body's sampler returned.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback throws, `fn` also
 *   when the body's first call returns a thenable, `calibration` when the sampler refuses a count,
 *   and `child` when the forced GC throws, after the state built and not torn down, if any, is torn
 *   down, save one whose teardown threw; a teardown error during that cleanup is discarded.
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
      : (state: State): void => {
          tearingDown = true;
          caseTeardown(state);
          tearingDown = false;
        };
  const inFlight: InFlight<State> = { held: false, state: undefined };
  try {
    const checked = setup();
    inFlight.state = checked;
    inFlight.held = true;
    requireSynchronous(fn(checked));
    trackedTeardown(checked);
    inFlight.held = false;
    inFlight.state = undefined;
    const run = samplePerCall({ ...sampling, setup, fn, teardown: trackedTeardown, inFlight });
    timing.endMs = performance.now();
    return run;
  } catch (error) {
    const phase = perCallPhase(error, inFlight.held, tearingDown);
    // A state whose teardown threw is left alone rather than torn down a second time.
    if (holds(inFlight) && phase !== "teardown") {
      tearDownDiscarding(teardown, inFlight.state);
    }
    throw failedIn(phase, error);
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
 * `measure`.
 *
 * @param error - The thrown value.
 * @param inFlight - Whether a state was built and not torn down.
 * @param tearingDown - Whether the case's teardown had started and not returned.
 * @returns `calibration` for the sampler's own refusal; otherwise `setup` with no state in flight,
 *   `teardown` while one was being torn down, and `fn` for the rest.
 */
function perCallPhase(error: unknown, inFlight: boolean, tearingDown: boolean): Phase {
  if (error instanceof CalibrationError) return "calibration";
  if (!inFlight) return "setup";
  return tearingDown ? "teardown" : "fn";
}

/**
 * Fails a body whose call returned a thenable: the samplers time calls, not settled promises.
 *
 * @param returned - What the body's first call returned.
 * @throws Error when `returned` has a callable `then`.
 */
function requireSynchronous(returned: unknown): void {
  if (
    (typeof returned === "object" || typeof returned === "function") &&
    returned !== null &&
    typeof Reflect.get(returned, "then") === "function"
  ) {
    throw new Error("benchmark bodies must be synchronous: the body returned a thenable");
  }
}

/**
 * Tears `state` down while an error is already in flight: that error wins, so the teardown's
 * own error is dropped rather than replacing it, which a `finally` would do.
 *
 * @param teardown - The benchmark's teardown.
 * @param state - The state to release.
 */
function tearDownDiscarding<State>(teardown: (state: State) => void, state: State): void {
  try {
    teardown(state);
  } catch {
    // The error already propagating is the one the caller sees.
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Reads one rank of the ascending per-call times.
 *
 * @param sorted - The per-call times, ascending.
 * @param rank - The zero-based rank to read.
 * @returns The time at that rank.
 * @throws RangeError when no time is stored at that rank, as when no span was stored at all.
 */
function timeAt(sorted: Float64Array, rank: number): number {
  const time = sorted[rank];
  if (time === undefined) {
    throw new RangeError(`no stored span at rank ${rank}: ${sorted.length} spans stored`);
  }
  return time;
}

/**
 * Reads quantile `q` of the ascending per-call times, linearly interpolated between the two
 * nearest ranks.
 *
 * @param sorted - The per-call times, ascending.
 * @param q - The quantile, from 0 to 1.
 * @returns The interpolated time.
 * @throws RangeError when no span was stored.
 */
function quantile(sorted: Float64Array, q: number): number {
  const position = (sorted.length - 1) * q;
  const lowerRank = Math.floor(position);
  const lowTime = timeAt(sorted, lowerRank);
  const highTime = timeAt(sorted, Math.ceil(position));
  return lowTime + (highTime - lowTime) * (position - lowerRank);
}

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
  let total = 0;
  for (const time of sorted) {
    total += time;
  }
  const summary = {
    min: quantile(sorted, 0),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p99: quantile(sorted, 0.99),
    max: quantile(sorted, 1),
    mean: total / sorted.length,
    sampleCount: sorted.length,
  };
  DIAG.push({ callsPerSample, ...summary });
  return summary;
}

// ---------------------------------------------------------------------------
// GC observation
// ---------------------------------------------------------------------------

/** A `gc` performance observer for the body's run. */
interface CollectionObserver {
  readonly during: (timing: TimingWindow) => Promise<GcDuringTiming>;
  readonly disconnect: () => void;
}

/**
 * Starts observing `gc` performance entries, where the runtime delivers them.
 *
 * @returns The observer, or `undefined` where the runtime has no `gc` entry type, as on Bun or in a
 *   browser.
 */
function observeCollections(): CollectionObserver | undefined {
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("gc")
  ) {
    return undefined;
  }
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    entries.push(...list.getEntries());
  });
  observer.observe({ entryTypes: ["gc"] });
  return {
    during: async (timing) => {
      // Node queues a gc entry from a native setImmediate callback and dispatches it to observers
      // after that: two timer turns guarantee the loop has passed its check phase between them.
      await nextTurn();
      await nextTurn();
      entries.push(...observer.takeRecords());
      return summarizeCollections(
        entries.filter(
          (entry) => entry.startTime >= timing.startMs && entry.startTime < timing.endMs,
        ),
      );
    },
    disconnect: () => {
      observer.disconnect();
    },
  };
}

/** Resolves after one `setTimeout(0)` turn of the event loop, so pending native callbacks have run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Counts collections by kind and sums their durations.
 *
 * @param entries - The `gc` performance entries to count.
 * @returns How many there were, how many were minor and major, and their total and longest
 *   duration in milliseconds.
 */
function summarizeCollections(entries: readonly PerformanceEntry[]): GcDuringTiming {
  let minor = 0;
  let major = 0;
  let totalMs = 0;
  let maxMs = 0;
  for (const entry of entries) {
    const kind = gcKind(entry);
    if (kind === GC_MINOR) minor += 1;
    if (kind === GC_MAJOR) major += 1;
    totalMs += entry.duration;
    maxMs = Math.max(maxMs, entry.duration);
  }
  return { count: entries.length, minor, major, totalMs, maxMs };
}

/**
 * Reads the forced GC kind Node records in a `gc` entry's `detail`.
 *
 * @param entry - A `gc` performance entry.
 * @returns The entry's `detail.kind`, or `undefined` when it carries none.
 */
function gcKind(entry: PerformanceEntry): unknown {
  const detail: unknown = Reflect.get(entry, "detail");
  return typeof detail === "object" && detail !== null ? Reflect.get(detail, "kind") : undefined;
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
