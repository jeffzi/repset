/**
 * The body samplers and the contract they share: the `Sampling` options, the `SamplerResult` a
 * sampler returns, the clock and the warmup and calibration code both samplers and the empty run
 * reuse, then the two samplers. Spans are in milliseconds.
 *
 * - `sampleSharedState` warms up to calibrate the calls per sample, then takes timing attempts, each
 *   after a collection, every sample on the caller's single state.
 * - `samplePerCall` is for a body that consumes its state, so every call runs on a fresh one. Each
 *   call builds a state, runs the body once on it between a pair of clock reads, then tears it
 *   down; a sample's span is the sum of its calls' spans, so no setup or teardown lands inside one.
 *   It takes a single timing attempt, so its `collect` runs once.
 *
 * Every function from either sampler down to the body is plain synchronous code: no `try`, `catch`,
 * `finally`, `async` function, generator or Promise encloses the timed calls or the loops around
 * them (VISION #1), since any of those changes how the engine compiles the loop. Error handling and
 * teardown belong to the caller; a per-call caller finds the state in flight in `inFlight`.
 *
 * The module imports only the generic helpers and reads no Node builtin, so it loads in a browser
 * page.
 */

import { valueAt } from "../utils.js";

/** Every sample spans at least this many multiples of the timer resolution once warmup calibrates its count. */
const MIN_RESOLUTIONS_PER_SAMPLE = 200;

/** A warmup sample that read no clock change multiplies its count by this: a zero span gives no ratio. */
const ZERO_STEP_GROWTH = 100;

/** The shortest body, in milliseconds (0.1 ns), whose sample of {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution the cap keeps reachable. */
const SHORTEST_BODY_MS = 1e-7;

/** The least time, on the sampler's clock, the shared-state and empty runs' warmups take. */
export const WARMUP_MIN_MS = 250;

/** The fewest warmup samples either sampler runs. */
export const WARMUP_MIN_SAMPLES = 16;

const PER_CALL_WARMUP_MIN_MS = 3000;
const WARMUP_MAX_SAMPLES = 1000;

/** The most timing attempts a calibrated count takes before the sampler gives up. */
const MAX_TIMING_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Sampler contract
// ---------------------------------------------------------------------------

/**
 * A sampler's refusal to time a body within its calibration: a count past the cap, or a third timing attempt
 * discarded too. `measure` tells it from an error the body throws by its class, never its message.
 */
export class CalibrationError extends Error {
  override name = "CalibrationError";
}

/** What every sampler is handed beyond the body: the clock, its resolution, the forced GC, a fixed count. */
export interface Sampling {
  /** The clock, in milliseconds. */
  readonly now: () => number;
  readonly resolutionMs: number;
  /**
   * Runs before every timing attempt, after the last warmup sample: once for a sampler that takes one
   * run, and again after each run the shared-state sampler discards.
   */
  readonly collect: () => void;
  /**
   * Calls per sample to run instead of calibrating one; bypasses the cap, and the shared-state
   * sampler's run check. Absent or `undefined` calibrates.
   */
  readonly callsPerSample?: number | undefined;
}

/**
 * What a body sampler's timing attempt must pass before it stops: both, unless the sample buffer fills
 * first. The empty run takes neither.
 */
export interface TimedMinimums {
  /**
   * The time, in milliseconds, the timed samples span at least: on the sampler's clock for the
   * shared-state sampler, in wall time with every setup and teardown for the per-call one.
   */
  readonly minTime: number;
  /** The fewest timed samples; each sample runs `callsPerSample` calls. */
  readonly minSamples: number;
}

interface SharedStateOptions<State> extends Sampling, TimedMinimums {
  readonly fn: (state: State) => unknown;
  /** The one state every sample runs on; the caller builds and tears it down. */
  readonly state: State;
  /** Runs after every timing attempt's last sample, before the run is checked. */
  readonly afterTiming?: () => void;
}

export interface SamplerResult {
  /** The kept run's spans, in milliseconds; only the first `sampleCount` entries are filled. */
  readonly spans: Float64Array;
  /** How many entries of `spans` are filled. */
  readonly sampleCount: number;
  /** The count every sample of the kept run ran, or the fixed count when one was given. */
  readonly callsPerSample: number;
  /** How many timing attempts were taken, the kept one included. */
  readonly timingAttemptCount: number;
  /**
   * The samples run before the kept run: warmup's, plus every sample of each discarded timing attempt.
   * A call outside any clock read, such as the per-call sampler's collection run, is not a sample.
   */
  readonly warmupSampleCount: number;
  /**
   * The kept run's length on the sampler's clock, in milliseconds, from the start of its first
   * sample to the end of its last; for the per-call sampler, every setup and teardown in between
   * included.
   */
  readonly timingMs: number;
}

type WarmupResult = Pick<SamplerResult, "callsPerSample" | "warmupSampleCount">;

// ---------------------------------------------------------------------------
// Count calibration
// ---------------------------------------------------------------------------

/**
 * The span, in milliseconds, of a sample at the {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution a calibrated count reaches.
 *
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution, in milliseconds.
 */
function calibratedSampleMs(resolutionMs: number): number {
  return MIN_RESOLUTIONS_PER_SAMPLE * resolutionMs;
}

/**
 * Allocates a sample buffer that holds `minTime` filled with samples of `sampleMs`, rounded up, plus
 * `minSamples`, so a run whose samples span `sampleMs` or more passes both minimums before it fills.
 *
 * @param minimums - The timed time and sample minimums.
 * @param sampleMs - The span, in milliseconds, each sample is expected to reach.
 * @returns The zeroed store.
 */
function sampleBuffer(minimums: TimedMinimums, sampleMs: number): Float64Array {
  return new Float64Array(Math.ceil(minimums.minTime / sampleMs) + minimums.minSamples);
}

/**
 * How many multiples of the timer resolution a span covers, rounded to the nearest: warmup, the run check and the count
 * growth all count multiples this way, so they agree.
 *
 * @param spanMs - The span, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns The span's whole multiples of the resolution.
 */
function resolutionsIn(spanMs: number, resolutionMs: number): number {
  return Math.round(spanMs / resolutionMs);
}

/**
 * The shortest span that read a clock change, so far: a span that read none never counts.
 *
 * @param shortest - The shortest span so far, or 0 when none has read a clock change.
 * @param spanMs - The span to consider, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `spanMs` when it read a clock change and is shorter than `shortest`, or `shortest` is 0;
 *   otherwise `shortest`.
 */
function shortestReadingStep(shortest: number, spanMs: number, resolutionMs: number): number {
  const readStep = resolutionsIn(spanMs, resolutionMs) > 0;
  return readStep && (shortest === 0 || spanMs < shortest) ? spanMs : shortest;
}

/**
 * The count the next warmup sample runs, from the span of the sample that just ended.
 *
 * @param count - The count that sample ran.
 * @param spanMs - That sample's span, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `count` when the span reached {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution; otherwise the count scaled up to reach {@link MIN_RESOLUTIONS_PER_SAMPLE}
 *   times the resolution, rounded up, or {@link ZERO_STEP_GROWTH} times `count` when the span read no clock change.
 */
function calibratedCount(count: number, spanMs: number, resolutionMs: number): number {
  const multiples = resolutionsIn(spanMs, resolutionMs);
  if (multiples >= MIN_RESOLUTIONS_PER_SAMPLE) {
    return count;
  }
  if (multiples === 0) {
    return count * ZERO_STEP_GROWTH;
  }
  return Math.ceil((count * MIN_RESOLUTIONS_PER_SAMPLE) / multiples);
}

/**
 * Refuses a count that passes `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`.
 *
 * @param next - The count asked for.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `next`.
 * @throws CalibrationError when `next` passes the cap, naming the count asked for and the cap.
 */
function withinCap(next: number, resolutionMs: number): number {
  const cap = Math.ceil(calibratedSampleMs(resolutionMs) / SHORTEST_BODY_MS);
  if (next > cap) {
    throw new CalibrationError(
      `warmup asked for ${String(next)} calls per sample, above the cap of ${String(cap)}`,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Warmup bookkeeping
// ---------------------------------------------------------------------------

/**
 * Either sampler's warmup bookkeeping between samples. Each sampler keeps its own loop, stop rule
 * and call to its own sample function, so no sampling loop runs another sampler's body.
 */
interface WarmupProgress {
  /** The calls the next warmup sample runs. */
  count: number;
  /** The warmup samples recorded so far. */
  samples: number;
  readonly resolutionMs: number;
  /** The fixed calls per sample, or `undefined` when warmup calibrates the count. */
  readonly fixed: number | undefined;
}

/**
 * Creates the warmup state a sampler's loop passes to `recordWarmup`, one sample at a time.
 *
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns Progress with no sample recorded, whose count is `fixed`, or 1 when calibrating.
 */
export function startWarmup(resolutionMs: number, fixed: number | undefined): WarmupProgress {
  return { count: fixed ?? 1, samples: 0, resolutionMs, fixed };
}

/**
 * Records a warmup sample: the count the next sample runs is calibrated again unless it was fixed.
 *
 * @param progress - The warmup's bookkeeping, updated in place.
 * @param spanMs - The span of the sample that just ran `progress.count` calls, in milliseconds.
 * @throws CalibrationError when the next count passes `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`, naming the count
 *   asked for and the cap, before any sample runs it.
 */
export function recordWarmup(progress: WarmupProgress, spanMs: number): void {
  progress.samples += 1;
  if (progress.fixed === undefined) {
    progress.count = withinCap(
      calibratedCount(progress.count, spanMs, progress.resolutionMs),
      progress.resolutionMs,
    );
  }
}

/**
 * Reads the count to time at and the warmup samples taken off a finished warmup.
 *
 * @param progress - The warmup's bookkeeping after its last sample.
 * @returns The count warmup ended on, and the samples it recorded.
 */
function warmedUp(progress: WarmupProgress): WarmupResult {
  return { callsPerSample: progress.count, warmupSampleCount: progress.samples };
}

// ---------------------------------------------------------------------------
// Shared-state timing loop
// ---------------------------------------------------------------------------

type Timed<State> = Pick<SharedStateOptions<State>, "now" | "fn" | "state">;

/**
 * Holds what the last sample's last call returned, so the engine cannot treat the body's result as
 * dead. One store per sample, after the clock read: a store on every call costs about 2 ns per call
 * on Node and hides a deleted body from the empty-body check.
 */
const consumed: { value: unknown } = { value: undefined };

/**
 * Times `count` consecutive calls of the body on its state between one pair of clock reads, then
 * keeps what the last call returned until the next sample replaces it.
 *
 * @param timed - The clock, the body, and its state.
 * @param count - Calls in this sample.
 * @returns The span, in milliseconds.
 * @throws Whatever the body throws.
 */
function sharedStateSample<State>(timed: Timed<State>, count: number): number {
  const { now, fn, state } = timed;
  let last: unknown;
  const started = now();
  for (let call = 0; call < count; call++) {
    last = fn(state);
  }
  const spanMs = now() - started;
  consumed.value = last;
  return spanMs;
}

/** What the shared-state warmup settles: its count, and the span a fixed count sizes the store by. */
interface SharedStateWarmup extends WarmupResult {
  /**
   * The shortest warmup sample that read a clock change, or one resolution when none did, in
   * milliseconds.
   */
  readonly shortestMs: number;
}

/**
 * Runs warmup samples until both {@link WARMUP_MIN_MS} ms and
 * {@link WARMUP_MIN_SAMPLES} samples have passed, calibrating the count unless
 * one was fixed.
 *
 * @param timed - The clock, the body, and its state.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on, the samples it ran, and its shortest sample that read a clock change.
 * @throws Whatever the body throws, and CalibrationError when the count would pass the cap, before any
 *   sample runs it.
 */
function sharedStateWarmup<State>(
  timed: Timed<State>,
  resolutionMs: number,
  fixed: number | undefined,
): SharedStateWarmup {
  const { now } = timed;
  const progress = startWarmup(resolutionMs, fixed);
  let shortestMs = 0;
  const started = now();
  while (progress.samples < WARMUP_MIN_SAMPLES || now() - started < WARMUP_MIN_MS) {
    const spanMs = sharedStateSample(timed, progress.count);
    shortestMs = shortestReadingStep(shortestMs, spanMs, resolutionMs);
    recordWarmup(progress, spanMs);
  }
  return { ...warmedUp(progress), shortestMs: shortestMs === 0 ? resolutionMs : shortestMs };
}

/** How a timing attempt ended. */
interface TimedAttempt {
  /** How many entries of the sample buffer the run filled. */
  readonly stored: number;
  /** Whether the store filled before both `minTime` and `minSamples` had passed. */
  readonly cutShort: boolean;
  /** The run's length on the sampler's clock, in milliseconds. */
  readonly lengthMs: number;
}

/**
 * Fills `spans` with timed samples until both `minTime` and `minSamples` have passed, or `spans` is
 * full, then reads the run's length once, after its last sample, so the loop takes no extra read.
 *
 * @param timed - The clock, the body, and its state.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param minimums - The time, on the sampler's clock, and the samples the run must pass.
 * @returns How many entries of `spans` were filled, whether the store filled first, and the run's
 *   length.
 * @throws Whatever the body throws.
 */
function timeSharedStateSamples<State>(
  timed: Timed<State>,
  count: number,
  spans: Float64Array,
  minimums: TimedMinimums,
): TimedAttempt {
  const { now } = timed;
  const { minTime, minSamples } = minimums;
  let stored = 0;
  let cutShort = false;
  const started = now();
  while (stored < minSamples || now() - started < minTime) {
    if (stored === spans.length) {
      cutShort = true;
      break;
    }
    spans[stored] = sharedStateSample(timed, count);
    stored += 1;
  }
  return { stored, cutShort, lengthMs: now() - started };
}

/**
 * Runs one timing attempt: the forced GC, the timed samples, then the after-timing callback.
 *
 * @param timed - The clock, the body, and its state.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param options - The `collect` callback that runs before the samples, the `afterTiming` callback
 *   that runs after the last sample, before the run is checked (absent means nothing), and the
 *   `minTime` and `minSamples` the run must pass.
 * @returns How many entries of `spans` were filled, whether the store filled first, and the run's
 *   length.
 * @throws Whatever the body, `collect` or `afterTiming` throws.
 */
function timingAttempt<State>(
  timed: Timed<State>,
  count: number,
  spans: Float64Array,
  options: Pick<SharedStateOptions<State>, "collect" | "afterTiming" | "minTime" | "minSamples">,
): TimedAttempt {
  options.collect();
  const run = timeSharedStateSamples(timed, count, spans, options);
  options.afterTiming?.();
  return run;
}

/**
 * Whether a timing attempt keeps its spans: it passed `minTime` and `minSamples` before filling the store,
 * and its median sample (the upper median for an even count) spans at least {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution, counted as
 * warmup counts them.
 *
 * @param spans - The sample buffer the run filled from its start.
 * @param run - How many entries the run filled, and whether the store filled first.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `true` when the run is kept, `false` when it is discarded.
 * @throws {RangeError} When a run that was not cut short stored no sample, which a `minSamples`
 *   below 1 allows.
 */
function isKept(spans: Float64Array, run: TimedAttempt, resolutionMs: number): boolean {
  const { stored, cutShort } = run;
  if (cutShort) {
    return false;
  }
  const sorted = spans.subarray(0, stored).toSorted();
  const median = valueAt(sorted, stored >> 1);
  return resolutionsIn(median, resolutionMs) >= MIN_RESOLUTIONS_PER_SAMPLE;
}

/**
 * The count the timing attempt after a discarded one runs: the smallest at which the discarded run's
 * shortest sample would have spanned {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution, and at least one call more than it ran. Samples that
 * read no clock change are left out of the shortest.
 *
 * @param count - The count the discarded run ran.
 * @param spans - The discarded run's spans, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns The next count, or {@link ZERO_STEP_GROWTH} times `count` when no sample read a clock change.
 * @throws CalibrationError when the next count passes `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`, naming the count asked
 *   for and the cap.
 */
function grownCount(count: number, spans: Float64Array, resolutionMs: number): number {
  let shortest = 0;
  for (const span of spans) {
    shortest = shortestReadingStep(shortest, span, resolutionMs);
  }
  return withinCap(
    Math.max(calibratedCount(count, shortest, resolutionMs), count + 1),
    resolutionMs,
  );
}

/**
 * Warms the body up, then times samples on the caller's one state in timing attempts, collecting
 * before each.
 *
 * A run takes samples until both `minTime`, on the sampler's clock, and `minSamples` have passed, or
 * the sample buffer is full. Unless the count was fixed, a run whose median sample spans under {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution,
 * or that filled the store first, is discarded: the count grows from its shortest sample and the
 * sampler times again, at most three runs in all. The check runs after `timeSharedStateSamples` returns, never
 * inside the timing loop. A fixed-count run that fills the store is returned as it is.
 *
 * The sample buffer holds `minTime` filled with samples of {@link MIN_RESOLUTIONS_PER_SAMPLE} times the resolution for a calibrated count, or of
 * warmup's shortest sample that read a clock change for a fixed one (one resolution when none did), rounded up,
 * plus `minSamples`. It is allocated before the first collection, so its allocation never lands in a
 * timed sample. Every run refills it from the start.
 *
 * @param options - The body, its state, the forced GC, the callback after each run, `minTime` and
 *   `minSamples`, and the clock.
 * @returns The kept run's spans and calls per sample, the timing attempts taken, warmup's samples plus
 *   every discarded run's, and the kept run's length on the sampler's clock.
 * @throws Whatever `fn`, `collect` or `afterTiming` throws; CalibrationError when warmup's or a grown
 *   count would pass `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`, naming the count asked for and the cap; and
 *   CalibrationError when the third run is discarded too, naming the count a fourth would need and the
 *   runs taken.
 */
export function sampleSharedState<State>(options: SharedStateOptions<State>): SamplerResult {
  const { fn, state, callsPerSample, now, resolutionMs } = options;
  const timed: Timed<State> = { now, fn, state };
  const warmed = sharedStateWarmup(timed, resolutionMs, callsPerSample);
  const spans = sampleBuffer(
    options,
    callsPerSample === undefined ? calibratedSampleMs(resolutionMs) : warmed.shortestMs,
  );
  let calls = warmed.callsPerSample;
  let warmupSampleCount = warmed.warmupSampleCount;
  let timingAttemptCount = 1;
  let run = timingAttempt(timed, calls, spans, options);
  if (callsPerSample === undefined) {
    while (!isKept(spans, run, resolutionMs)) {
      calls = grownCount(calls, spans.subarray(0, run.stored), resolutionMs);
      if (timingAttemptCount === MAX_TIMING_ATTEMPTS) {
        throw new CalibrationError(
          `${String(timingAttemptCount)} timing attempts were discarded; the next would need ${String(calls)} calls per sample`,
        );
      }
      warmupSampleCount += run.stored;
      run = timingAttempt(timed, calls, spans, options);
      timingAttemptCount += 1;
    }
  }
  return {
    spans,
    sampleCount: run.stored,
    callsPerSample: calls,
    timingAttemptCount,
    warmupSampleCount,
    timingMs: run.lengthMs,
  };
}

// ---------------------------------------------------------------------------
// Per-call timing loop
// ---------------------------------------------------------------------------

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

interface PerCallOptions<State> extends Sampling, TimedMinimums {
  /** Builds the fresh state one body call consumes. */
  readonly setup: () => State;
  /** The benchmark body; every call receives a state built for it alone. */
  readonly fn: (state: State) => void;
  /** Tears down a state once its body call returned. */
  readonly teardown: (state: State) => void;
  /** Receives the state in flight; no two states are ever alive at once. */
  readonly inFlight: InFlight<State>;
}

type PerCall<State> = Pick<PerCallOptions<State>, "now" | "setup" | "fn" | "teardown" | "inFlight">;

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
function perCallSample<State>(perCall: PerCall<State>, count: number): number {
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
 * Runs warmup samples until {@link WARMUP_MAX_SAMPLES} have run, or until both
 * {@link PER_CALL_WARMUP_MIN_MS} ms of wall time, every setup and teardown included, and
 * {@link WARMUP_MIN_SAMPLES} samples have passed, calibrating the count unless one was fixed.
 *
 * @param perCall - The clock, the lifecycle, and the holder of the state in flight.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on, and the samples it ran.
 * @throws Whatever `setup`, `fn` or `teardown` throws, and CalibrationError when the calibrated count
 *   would pass `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`, naming the count asked for and the cap, before any
 *   sample runs it.
 */
function perCallWarmup<State>(
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
    const spanMs = perCallSample(perCall, progress.count);
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
function timePerCallSamples<State>(
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
    spans[stored] = perCallSample(perCall, count);
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
 * that fills the store is returned as it is. The store holds `minTime` filled with samples of {@link MIN_RESOLUTIONS_PER_SAMPLE}
 * times the resolution, rounded up, plus `minSamples`, whether or not the count was fixed, and is
 * allocated before the forced GC, so its allocation never lands in a timed sample. No two states
 * are ever alive at once.
 *
 * @param options - The lifecycle, the forced GC, the holder of the state in flight, `minTime` and
 *   `minSamples`, and the clock.
 * @returns The timed spans, the calls per sample, `timingAttemptCount` of 1 (this sampler never
 *   checks a timing attempt or times again), warmup's samples without the forced GC's call, and
 *   the timed run's wall time, every setup and teardown in it included.
 * @throws Whatever `setup`, `fn`, `teardown` or `collect` throws, leaving the state built and not
 *   torn down, if any, in `options.inFlight`; and CalibrationError when warmup's calibrated count
 *   would pass `ceil(MIN_RESOLUTIONS_PER_SAMPLE × resolution / SHORTEST_BODY_MS)`, naming the count asked for and the cap, before any
 *   sample runs it.
 */
export function samplePerCall<State>(options: PerCallOptions<State>): SamplerResult {
  const { setup, fn, teardown, collect, callsPerSample, now, resolutionMs, inFlight } = options;
  const perCall: PerCall<State> = { now, setup, fn, teardown, inFlight };
  const warmed = perCallWarmup(perCall, resolutionMs, callsPerSample);
  const spans = sampleBuffer(options, calibratedSampleMs(resolutionMs));
  const state = setup();
  holdInFlight(inFlight, state);
  fn(state);
  collect();
  teardown(state);
  releaseInFlight(inFlight);
  const { sampleCount, timingMs } = timePerCallSamples(
    perCall,
    warmed.callsPerSample,
    spans,
    options,
  );
  return {
    spans,
    sampleCount,
    callsPerSample: warmed.callsPerSample,
    timingAttemptCount: 1,
    warmupSampleCount: warmed.warmupSampleCount,
    timingMs,
  };
}
