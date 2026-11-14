/**
 * The shared-state sampler: warmup that calibrates the calls per sample, then timing attempts, each
 * after a collection, every sample on the caller's single state. Spans are in milliseconds.
 *
 * Every function from `sampleSharedState` down to the body is plain synchronous code: no `try`,
 * `catch`, `finally`, `async` function, generator or Promise encloses the timed calls or the loops
 * around them (VISION #1), since any of those changes how the engine compiles the loop. Error
 * handling and teardown belong to the caller.
 *
 * The module imports only `./timer.js` and reads no Node builtin, so it loads in a browser page.
 */

import { performanceNow, timerResolutionMs } from "./timer.js";

/** Every sample spans at least this many multiples of the timer resolution once warmup calibrates its count. */
const MIN_RESOLUTIONS_PER_SAMPLE = 200;

/** A warmup sample that read no clock change multiplies its count by this: a zero span gives no ratio. */
const ZERO_STEP_GROWTH = 100;

/** The shortest body, in milliseconds (0.1 ns), whose sample of 200 times the resolution the cap keeps reachable. */
const SHORTEST_BODY_MS = 1e-7;

const WARMUP_MIN_MS = 250;

/** The fewest warmup samples either sampler runs. */
export const WARMUP_MIN_SAMPLES = 16;

/** The most timing attempts a calibrated count takes before the sampler gives up. */
const MAX_TIMING_RUNS = 3;

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
  /** The clock's resolution, in milliseconds. */
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

/** A sampler's own clock and resolution, each defaulting when absent. */
export type SamplerClock = Partial<Pick<Sampling, "now" | "resolutionMs">>;

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

/** `now` defaults to `performance.now()`, and `resolutionMs` to a probe of `now`. */
export interface SharedStateOptions<State>
  extends Omit<Sampling, "now" | "resolutionMs">, SamplerClock, TimedMinimums {
  /** The benchmark body; every call receives `state`. */
  readonly fn: (state: State) => unknown;
  /** The one state every sample runs on; the caller builds and tears it down. */
  readonly state: State;
  /** Runs after every timing attempt's last sample, before the run is checked. */
  readonly afterTiming?: () => void;
}

export interface SamplerResult {
  /** The kept run's spans, in milliseconds; only the first `samples` entries are filled. */
  readonly spans: Float64Array;
  /** How many entries of `spans` are filled. */
  readonly sampleCount: number;
  /** The count every sample of the kept run ran, or the fixed count when one was given. */
  readonly callsPerSample: number;
  /** How many timing attempts were taken, the kept one included. */
  readonly timingAttempts: number;
  /**
   * The samples run before the kept run: warmup's, plus every sample of each discarded timing attempt.
   * A call outside any clock read, such as the per-call sampler's collection run, is not a sample.
   */
  readonly warmupSamples: number;
  /**
   * The kept run's length on the sampler's clock, in milliseconds, from the start of its first
   * sample to the end of its last; for the per-call sampler, every setup and teardown in between
   * included.
   */
  readonly timingMs: number;
}

export type WarmupResult = Pick<SamplerResult, "callsPerSample" | "warmupSamples">;

/**
 * The span, in milliseconds, of a sample at the 200 times the resolution a calibrated count reaches.
 *
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns 200 times the resolution, in milliseconds.
 */
export function calibratedSampleMs(resolutionMs: number): number {
  return MIN_RESOLUTIONS_PER_SAMPLE * resolutionMs;
}

/**
 * Allocates a sample buffer that holds `time` filled with samples of `sampleMs`, rounded up, plus
 * `samples`, so a run whose samples span `sampleMs` or more passes both minimums before it fills.
 *
 * @param minimums - The timed time and sample minimums.
 * @param sampleMs - The span, in milliseconds, each sample is expected to reach.
 * @returns The zeroed store.
 */
export function sampleBuffer(minimums: TimedMinimums, sampleMs: number): Float64Array {
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
 * @returns `count` when the span reached 200 times the resolution; otherwise the count scaled up to reach 200
 *   times the resolution, rounded up, or 100 times `count` when the span read no clock change.
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
 * The count the next batched warmup sample runs, as {@link calibratedCount} gives it, refused once
 * it passes `ceil(200 × resolution / 0.1 ns)`: a body shorter than 0.1 ns is too short to time.
 *
 * @param count - The count that sample ran.
 * @param spanMs - That sample's span, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns The next count.
 * @throws CalibrationError when the next count passes the cap, naming the count asked for and the cap.
 */
export function cappedCount(count: number, spanMs: number, resolutionMs: number): number {
  return withinCap(calibratedCount(count, spanMs, resolutionMs), resolutionMs);
}

/**
 * Refuses a count that passes `ceil(200 × resolution / 0.1 ns)`.
 *
 * @param next - The count asked for.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `next`.
 * @throws CalibrationError when `next` passes the cap, naming the count asked for and the cap.
 */
function withinCap(next: number, resolutionMs: number): number {
  const cap = Math.ceil((MIN_RESOLUTIONS_PER_SAMPLE * resolutionMs) / SHORTEST_BODY_MS);
  if (next > cap) {
    throw new CalibrationError(
      `warmup asked for ${String(next)} calls per sample, above the cap of ${String(cap)}`,
    );
  }
  return next;
}

/**
 * Either sampler's warmup bookkeeping between samples. Each sampler keeps its own loop, stop rule
 * and call to its own `sample`, so no sampling loop runs another sampler's body.
 */
export interface WarmupProgress {
  /** The calls the next warmup sample runs. */
  count: number;
  /** The warmup samples recorded so far. */
  samples: number;
  readonly resolutionMs: number;
  /** The fixed calls per sample, or `undefined` when warmup calibrates the count. */
  readonly fixed: number | undefined;
}

/**
 * Starts a warmup's bookkeeping, before its first sample.
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
 * @throws CalibrationError when the next count passes `ceil(200 × resolution / 0.1 ns)`, naming the count
 *   asked for and the cap, before any sample runs it.
 */
export function recordWarmup(progress: WarmupProgress, spanMs: number): void {
  progress.samples += 1;
  if (progress.fixed === undefined) {
    progress.count = cappedCount(progress.count, spanMs, progress.resolutionMs);
  }
}

/**
 * Ends a warmup's bookkeeping.
 *
 * @param progress - The warmup's bookkeeping after its last sample.
 * @returns The count warmup ended on, and the samples it recorded.
 */
export function warmedUp(progress: WarmupProgress): WarmupResult {
  return { callsPerSample: progress.count, warmupSamples: progress.samples };
}

interface Timed<State> {
  readonly now: () => number;
  readonly fn: (state: State) => unknown;
  readonly state: State;
}

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
function sample<State>(timed: Timed<State>, count: number): number {
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
 * Runs warmup samples until both 250 ms and 16 samples have passed, calibrating the count unless
 * one was fixed.
 *
 * @param timed - The clock, the body, and its state.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on, the samples it ran, and its shortest sample that read a clock change.
 * @throws Whatever the body throws, and CalibrationError when the count would pass the cap, before any
 *   sample runs it.
 */
function warmup<State>(
  timed: Timed<State>,
  resolutionMs: number,
  fixed: number | undefined,
): SharedStateWarmup {
  const { now } = timed;
  const progress = startWarmup(resolutionMs, fixed);
  let shortestMs = 0;
  const started = now();
  while (progress.samples < WARMUP_MIN_SAMPLES || now() - started < WARMUP_MIN_MS) {
    const spanMs = sample(timed, progress.count);
    shortestMs = shortestReadingStep(shortestMs, spanMs, resolutionMs);
    recordWarmup(progress, spanMs);
  }
  return { ...warmedUp(progress), shortestMs: shortestMs === 0 ? resolutionMs : shortestMs };
}

/** How a timing attempt ended. */
interface TimedAttempt {
  /** How many entries of the sample buffer the run filled. */
  readonly stored: number;
  /** Whether the store filled before both `time` and `samples` had passed. */
  readonly cutShort: boolean;
  /** The run's length on the sampler's clock, in milliseconds. */
  readonly lengthMs: number;
}

/**
 * Fills `spans` with timed samples until both `time` and `samples` have passed, or `spans` is
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
function timeSamples<State>(
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
    spans[stored] = sample(timed, count);
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
 * @param hooks - The `collect` callback that runs before the samples, the `afterTiming` callback
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
  hooks: Pick<SharedStateOptions<State>, "collect" | "afterTiming" | "minTime" | "minSamples">,
): TimedAttempt {
  hooks.collect();
  const run = timeSamples(timed, count, spans, hooks);
  hooks.afterTiming?.();
  return run;
}

/**
 * Whether a timing attempt keeps its spans: it passed `time` and `samples` before filling the store,
 * and its median sample (the upper median for an even count) spans at least 200 times the resolution, counted as
 * warmup counts them.
 *
 * @param spans - The sample buffer the run filled from its start.
 * @param run - How many entries the run filled, and whether the store filled first.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns `true` when the run is kept, `false` when it is discarded.
 */
function isKept(spans: Float64Array, run: TimedAttempt, resolutionMs: number): boolean {
  const { stored, cutShort } = run;
  if (cutShort) {
    return false;
  }
  const sorted = spans.subarray(0, stored).toSorted();
  const median = sorted[stored >> 1] ?? 0;
  return resolutionsIn(median, resolutionMs) >= MIN_RESOLUTIONS_PER_SAMPLE;
}

/**
 * The count the timing attempt after a discarded one runs: the smallest at which the discarded run's
 * shortest sample would have spanned 200 times the resolution, and at least one call more than it ran. Samples that
 * read no clock change are left out of the shortest.
 *
 * @param count - The count the discarded run ran.
 * @param spans - The discarded run's spans, in milliseconds.
 * @param resolutionMs - The timer resolution, in milliseconds.
 * @returns The next count, or 100 times `count` when no sample read a clock change.
 * @throws CalibrationError when the next count passes `ceil(200 × resolution / 0.1 ns)`, naming the count asked
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
 * A run takes samples until both `time`, on the sampler's clock, and `samples` have passed, or the
 * sample buffer is full. Unless the count was fixed, a run whose median sample spans under 200 times the resolution,
 * or that filled the store first, is discarded: the count grows from its shortest sample and the
 * sampler times again, at most three runs in all. The check runs after `timeSamples` returns, never
 * inside the timing loop. A fixed-count run that fills the store is returned as it is.
 *
 * The sample buffer holds `time` filled with samples of 200 times the resolution for a calibrated count, or of
 * warmup's shortest sample that read a clock change for a fixed one (one resolution when none did), rounded up,
 * plus `samples`. It is allocated before the first collection, so its allocation never lands in a
 * timed sample. Every run refills it from the start.
 *
 * @param options - The body, its state, the forced GC, the callback after each run, `time` and
 *   `samples`, and the clock.
 * @returns The kept run's spans and calls per sample, the timing attempts taken, warmup's samples plus
 *   every discarded run's, and the kept run's length on the sampler's clock.
 * @throws Whatever `fn`, `collect` or `afterTiming` throws; CalibrationError when warmup's or a grown
 *   count would pass `ceil(200 × resolution / 0.1 ns)`, naming the count asked for and the cap; and
 *   CalibrationError when the third run is discarded too, naming the count a fourth would need and the
 *   runs taken.
 */
export function sampleSharedState<State>(options: SharedStateOptions<State>): SamplerResult {
  const { fn, state, callsPerSample } = options;
  const now = options.now ?? performanceNow;
  const resolutionMs = options.resolutionMs ?? timerResolutionMs(now);
  const timed: Timed<State> = { now, fn, state };
  const warmed = warmup(timed, resolutionMs, callsPerSample);
  const spans = sampleBuffer(
    options,
    callsPerSample === undefined ? calibratedSampleMs(resolutionMs) : warmed.shortestMs,
  );
  let calls = warmed.callsPerSample;
  let warmupSamples = warmed.warmupSamples;
  let timingAttempts = 1;
  let run = timingAttempt(timed, calls, spans, options);
  if (callsPerSample === undefined) {
    while (!isKept(spans, run, resolutionMs)) {
      calls = grownCount(calls, spans.subarray(0, run.stored), resolutionMs);
      if (timingAttempts === MAX_TIMING_RUNS) {
        throw new CalibrationError(
          `${String(timingAttempts)} timing attempts were discarded; the next would need ${String(calls)} calls per sample`,
        );
      }
      warmupSamples += run.stored;
      run = timingAttempt(timed, calls, spans, options);
      timingAttempts += 1;
    }
  }
  return {
    spans,
    sampleCount: run.stored,
    callsPerSample: calls,
    timingAttempts,
    warmupSamples,
    timingMs: run.lengthMs,
  };
}
