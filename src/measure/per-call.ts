/**
 * The per-call sampler: for a body that consumes its state, so every call runs on a fresh one.
 * Each call builds a state, runs the body once on it between a pair of clock reads, then tears it
 * down; a sample's span is the sum of its calls' spans, so no setup or teardown lands inside one.
 * Spans are in milliseconds. The result is the `SamplerResult` every sampler returns, and `collect`,
 * `now`, `resolutionMs` and `callsPerSample` mean what they mean there, except that `collect` runs once:
 * this sampler takes a single timing attempt.
 *
 * Every function from `samplePerCall` down to the body is plain synchronous code: no `try`,
 * `catch`, `finally`, `async` function, generator or Promise encloses the timed calls or the loops
 * around them (VISION #1), since any of those changes how the engine compiles the loop. Error
 * handling and teardown on a throw belong to the caller, which finds the state in flight in
 * `inFlight`.
 *
 * The module imports only `../utils.js` and sibling `measure` modules and reads no Node builtin, so it loads in a
 * browser page.
 */

import type { StrictOmit } from "../utils.js";
import {
  calibratedSampleMs,
  recordWarmup,
  resolvedClock,
  sampleBuffer,
  startWarmup,
  warmedUp,
  WARMUP_MIN_SAMPLES,
  type SamplerClock,
  type SamplerResult,
  type Sampling,
  type TimedMinimums,
  type WarmupResult,
} from "./sampler.js";

const PER_CALL_WARMUP_MIN_MS = 3000;
const WARMUP_MAX_SAMPLES = 1000;

/**
 * The state a per-call run built and has not torn down. The sampler sets `state` and then `held`
 * on setup, and clears both once its teardown returned, so a caller that catches a throw from the
 * sampler can tear down the state left in flight. `held`, not `state`, says whether one is: a
 * setup may return `undefined`.
 */
export interface InFlight<State> {
  /** Whether a state was built and not yet torn down; while it is, `state` is that state. */
  held: boolean;
  state: State | undefined;
}

/**
 * Records a state built and not yet torn down: `state` first, then `held`.
 *
 * @param inFlight - The holder to write.
 * @param state - The state just built.
 */
export function holdInFlight<State>(inFlight: InFlight<State>, state: State): void {
  inFlight.state = state;
  inFlight.held = true;
}

/**
 * Records that the state in flight was torn down: `held` first, then `state`.
 *
 * @param inFlight - The holder to clear.
 */
export function releaseInFlight<State>(inFlight: InFlight<State>): void {
  inFlight.held = false;
  inFlight.state = undefined;
}

/** `now` defaults to `performance.now()`, and `resolutionMs` to a probe of `now`. */
export interface PerCallOptions<State>
  extends StrictOmit<Sampling, "now" | "resolutionMs">, SamplerClock, TimedMinimums {
  /** Builds the fresh state one body call consumes. */
  readonly setup: () => State;
  /** The benchmark body; every call receives a state built for it alone. */
  readonly fn: (state: State) => void;
  /** Tears down a state once its body call returned; defaults to doing nothing. */
  readonly teardown?: (state: State) => void;
  /** Receives the state in flight; no two states are ever alive at once. */
  readonly inFlight?: InFlight<State>;
}

interface PerCall<State> {
  readonly now: () => number;
  readonly setup: () => State;
  readonly fn: (state: State) => void;
  readonly teardown: (state: State) => void;
  readonly inFlight: InFlight<State>;
}

/** The teardown of a benchmark that gives none. */
export function keep(): void {
  // A state without a teardown is left to the garbage collector.
}

/**
 * Times `count` body calls, each on a state built just before its clock reads and torn down
 * just after.
 *
 * @param perCall - The clock, the lifecycle, and the holder of the state in flight.
 * @param count - Calls in this sample.
 * @returns The sum of the calls' spans, in milliseconds.
 * @throws Whatever `setup`, `fn` or `teardown` throws, leaving the state in flight in
 *   `perCall.inFlight`.
 */
function sample<State>(perCall: PerCall<State>, count: number): number {
  const { now, setup, fn, teardown, inFlight } = perCall;
  let summed = 0;
  for (let call = 0; call < count; call++) {
    const state = setup();
    holdInFlight(inFlight, state);
    const started = now();
    fn(state);
    summed += now() - started;
    teardown(state);
    releaseInFlight(inFlight);
  }
  return summed;
}

/**
 * Runs warmup samples until 1000 have run, or until both 3000 ms of wall time, every setup and
 * teardown included, and 16 samples have passed, calibrating the count unless one was fixed.
 *
 * @param perCall - The clock, the lifecycle, and the holder of the state in flight.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on, and the samples it ran.
 * @throws Whatever `setup`, `fn` or `teardown` throws, and CalibrationError when the calibrated count
 *   would pass `ceil(200 × resolution / 0.1 ns)`, naming the count asked for and the cap, before any
 *   sample runs it.
 */
function warmup<State>(
  perCall: PerCall<State>,
  resolutionMs: number,
  fixed: number | undefined,
): WarmupResult {
  const { now } = perCall;
  const progress = startWarmup(resolutionMs, fixed);
  const started = now();
  let elapsedMs = 0;
  while (
    progress.samples < WARMUP_MAX_SAMPLES &&
    (progress.samples < WARMUP_MIN_SAMPLES || elapsedMs < PER_CALL_WARMUP_MIN_MS)
  ) {
    const spanMs = sample(perCall, progress.count);
    elapsedMs = now() - started;
    recordWarmup(progress, spanMs);
  }
  return warmedUp(progress);
}

/**
 * Fills `spans` with timed samples until it is full, or until both `minTime` of wall time, every
 * setup and teardown included, and `minSamples` have passed.
 *
 * @param perCall - The clock, the lifecycle, and the holder of the state in flight.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param minimums - The wall time and the samples the run must pass.
 * @returns How many entries of `spans` were filled, and the run's wall time from before its first
 *   sample's first setup to after its last sample's last teardown.
 * @throws Whatever `setup`, `fn` or `teardown` throws.
 */
function timeSamples<State>(
  perCall: PerCall<State>,
  count: number,
  spans: Float64Array,
  minimums: TimedMinimums,
): Pick<SamplerResult, "sampleCount" | "timingMs"> {
  const { now } = perCall;
  const { minTime, minSamples } = minimums;
  const capacity = spans.length;
  let stored = 0;
  const started = now();
  let elapsedMs = 0;
  while (stored < capacity && (stored < minSamples || elapsedMs < minTime)) {
    spans[stored] = sample(perCall, count);
    elapsedMs = now() - started;
    stored += 1;
  }
  return { sampleCount: stored, timingMs: elapsedMs };
}

/**
 * Warms a perCall body up, collects once, then times every sample, each call on a fresh state.
 *
 * The forced GC builds one state, runs the body on it outside any clock read, calls `collect`
 * while it is alive, then tears it down. Timing takes samples until both `minTime`, in wall time
 * with every setup and teardown, and `minSamples` have passed, or the sample buffer is full; a run
 * that fills the store is returned as it is. The store holds `minTime` filled with samples of 200
 * times the resolution, rounded up, plus `minSamples`, whether or not the count was fixed, and is
 * allocated before the forced GC, so its allocation never lands in a timed sample. No two states
 * are ever alive at once.
 *
 * @param options - The lifecycle, the forced GC, the holder of the state in flight, `minTime` and
 *   `minSamples`, and the clock.
 * @returns The timed spans, the calls per sample, `timingAttempts` of 1 (this sampler never checks a
 *   timing attempt or times again), warmup's samples without the forced GC's call, and the
 *   timed run's wall time, every setup and teardown in it included.
 * @throws Whatever `setup`, `fn`, `teardown` or `collect` throws, leaving the state built and not
 *   torn down, if any, in `options.inFlight`; and CalibrationError when warmup's calibrated count would pass
 *   `ceil(200 × resolution / 0.1 ns)`, naming the count asked for and the cap, before any sample runs it.
 */
export function samplePerCall<State>(options: PerCallOptions<State>): SamplerResult {
  const { setup, fn, collect, callsPerSample } = options;
  const { now, resolutionMs } = resolvedClock(options);
  const teardown = options.teardown ?? keep;
  const inFlight = options.inFlight ?? { held: false, state: undefined };
  const perCall: PerCall<State> = { now, setup, fn, teardown, inFlight };
  const warmed = warmup(perCall, resolutionMs, callsPerSample);
  const spans = sampleBuffer(options, calibratedSampleMs(resolutionMs));
  const held = setup();
  holdInFlight(inFlight, held);
  fn(held);
  collect();
  teardown(held);
  releaseInFlight(inFlight);
  const { sampleCount, timingMs } = timeSamples(perCall, warmed.callsPerSample, spans, options);
  return {
    spans,
    sampleCount,
    callsPerSample: warmed.callsPerSample,
    timingAttempts: 1,
    warmupSamples: warmed.warmupSamples,
    timingMs,
  };
}
