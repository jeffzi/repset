/**
 * The shared-context sampler: warmup that calibrates the calls per sample, then timing runs, each
 * after a collection, every sample on the caller's single context. Spans are in milliseconds.
 *
 * Every function from `sampleSharedContext` down to the body is plain synchronous code: no `try`,
 * `catch`, `finally`, `async` function, generator or Promise encloses the timed calls or the loops
 * around them (VISION #1), since any of those changes how the engine compiles the loop. Error
 * handling and teardown belong to the caller.
 *
 * The module imports only `./timer.js` and reads no Node builtin, so it loads in a browser page.
 */

import { performanceNow, timerStepMs } from "./timer.js";

/** Every sample spans at least this many timer steps once warmup calibrates its count. */
const MIN_STEPS_PER_SAMPLE = 200;

/** A warmup sample that read no step multiplies its count by this: a zero span gives no ratio. */
const ZERO_STEP_GROWTH = 100;

/** The shortest body, in milliseconds (0.1 ns), whose 200-step sample the cap keeps reachable. */
const SHORTEST_BODY_MS = 1e-7;

const WARMUP_MIN_MS = 250;

/** The fewest warmup samples either sampler runs. */
export const WARMUP_MIN_SAMPLES = 16;

/** The most timing runs a calibrated count takes before the sampler gives up. */
const MAX_TIMING_RUNS = 3;

/** What every sampler is handed beyond the body: the clock, its step, the collection, a fixed count. */
export interface Sampling {
  /** The clock, in milliseconds. */
  readonly now: () => number;
  /** The clock's step, in milliseconds. */
  readonly stepMs: number;
  /**
   * Runs before every timing run, after the last warmup sample: once for a sampler that takes one
   * run, and again after each run the shared-context sampler discards.
   */
  readonly collect: () => void;
  /**
   * Calls per sample to run instead of calibrating one; bypasses the cap, and the shared-context
   * sampler's run check. Absent or `undefined` calibrates.
   */
  readonly callsPerSample?: number | undefined;
}

/** A sampler's own clock and step, each defaulting when absent. */
export type SamplerClock = Partial<Pick<Sampling, "now" | "stepMs">>;

/**
 * What a body sampler's timing run must pass before it stops: both, unless the span store fills
 * first. The empty run takes neither.
 */
export interface TimedMinimums {
  /**
   * The time, in milliseconds, the timed samples span at least: on the sampler's clock for the
   * shared-context sampler, in wall time with every setup and teardown for the per-call one.
   */
  readonly time: number;
  /** The fewest timed samples; each sample runs `callsPerSample` calls. */
  readonly samples: number;
}

/** `now` defaults to `performance.now()`, and `stepMs` to a probe of `now`. */
export interface SharedContextOptions<Context>
  extends Omit<Sampling, "now" | "stepMs">, SamplerClock, TimedMinimums {
  /** The benchmark body; every call receives `context`. */
  readonly fn: (context: Context) => unknown;
  /** The one context every sample runs on; the caller builds and tears it down. */
  readonly context: Context;
  /** Runs after every timing run's last sample, before the run is checked. */
  readonly afterTiming?: () => void;
}

export interface SamplerResult {
  /** The kept run's spans, in milliseconds; only the first `samples` entries are filled. */
  readonly spans: Float64Array;
  /** How many entries of `spans` are filled. */
  readonly samples: number;
  /** The count every sample of the kept run ran, or the fixed count when one was given. */
  readonly callsPerSample: number;
  /** How many timing runs were taken, the kept one included. */
  readonly timingRuns: number;
}

/** What a warmup settles: the count it ended on. */
export type WarmupResult = Pick<SamplerResult, "callsPerSample">;

/**
 * The span, in milliseconds, of a sample at the 200 steps a calibrated count reaches.
 *
 * @param stepMs - The timer step, in milliseconds.
 * @returns 200 steps, in milliseconds.
 */
export function calibratedSampleMs(stepMs: number): number {
  return MIN_STEPS_PER_SAMPLE * stepMs;
}

/**
 * Allocates a span store that holds `time` filled with samples of `sampleMs`, rounded up, plus
 * `samples`, so a run whose samples span `sampleMs` or more passes both minimums before it fills.
 *
 * @param minimums - The timed time and sample minimums.
 * @param sampleMs - The span, in milliseconds, each sample is expected to reach.
 * @returns The zeroed store.
 */
export function spanStore(minimums: TimedMinimums, sampleMs: number): Float64Array {
  return new Float64Array(Math.ceil(minimums.time / sampleMs) + minimums.samples);
}

/**
 * How many timer steps a span covers, rounded to the nearest: warmup, the run check and the count
 * growth all count steps this way, so they agree.
 *
 * @param spanMs - The span, in milliseconds.
 * @param stepMs - The timer step, in milliseconds.
 * @returns The span's whole steps.
 */
function stepsIn(spanMs: number, stepMs: number): number {
  return Math.round(spanMs / stepMs);
}

/**
 * The shortest span that read a timer step, so far: a span that read none never counts.
 *
 * @param shortest - The shortest span so far, or 0 when none has read a step.
 * @param spanMs - The span to consider, in milliseconds.
 * @param stepMs - The timer step, in milliseconds.
 * @returns `spanMs` when it read a step and is shorter than `shortest`, or `shortest` is 0;
 *   otherwise `shortest`.
 */
function shortestReadingStep(shortest: number, spanMs: number, stepMs: number): number {
  const readStep = stepsIn(spanMs, stepMs) > 0;
  return readStep && (shortest === 0 || spanMs < shortest) ? spanMs : shortest;
}

/**
 * The count the next warmup sample runs, from the span of the sample that just ended.
 *
 * @param count - The count that sample ran.
 * @param spanMs - That sample's span, in milliseconds.
 * @param stepMs - The timer step, in milliseconds.
 * @returns `count` when the span reached 200 steps; otherwise the count scaled up to reach 200
 *   steps, rounded up, or 100 times `count` when the span read no step.
 */
function calibratedCount(count: number, spanMs: number, stepMs: number): number {
  const steps = stepsIn(spanMs, stepMs);
  if (steps >= MIN_STEPS_PER_SAMPLE) {
    return count;
  }
  if (steps === 0) {
    return count * ZERO_STEP_GROWTH;
  }
  return Math.ceil((count * MIN_STEPS_PER_SAMPLE) / steps);
}

/**
 * The count the next batched warmup sample runs, as {@link calibratedCount} gives it, refused once
 * it passes `ceil(200 × step / 0.1 ns)`: a body shorter than 0.1 ns is too short to time.
 *
 * @param count - The count that sample ran.
 * @param spanMs - That sample's span, in milliseconds.
 * @param stepMs - The timer step, in milliseconds.
 * @returns The next count.
 * @throws Error when the next count passes the cap, naming the count asked for and the cap.
 */
export function cappedCount(count: number, spanMs: number, stepMs: number): number {
  return withinCap(calibratedCount(count, spanMs, stepMs), stepMs);
}

/**
 * Refuses a count that passes `ceil(200 × step / 0.1 ns)`.
 *
 * @param next - The count asked for.
 * @param stepMs - The timer step, in milliseconds.
 * @returns `next`.
 * @throws Error when `next` passes the cap, naming the count asked for and the cap.
 */
function withinCap(next: number, stepMs: number): number {
  const cap = Math.ceil((MIN_STEPS_PER_SAMPLE * stepMs) / SHORTEST_BODY_MS);
  if (next > cap) {
    throw new Error(
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
  readonly stepMs: number;
  /** The fixed calls per sample, or `undefined` when warmup calibrates the count. */
  readonly fixed: number | undefined;
}

/**
 * Starts a warmup's bookkeeping, before its first sample.
 *
 * @param stepMs - The timer step, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns Progress with no sample recorded, whose count is `fixed`, or 1 when calibrating.
 */
export function startWarmup(stepMs: number, fixed: number | undefined): WarmupProgress {
  return { count: fixed ?? 1, samples: 0, stepMs, fixed };
}

/**
 * Records a warmup sample: the count the next sample runs is calibrated again unless it was fixed.
 *
 * @param progress - The warmup's bookkeeping, updated in place.
 * @param spanMs - The span of the sample that just ran `progress.count` calls, in milliseconds.
 * @throws Error when the next count passes `ceil(200 × step / 0.1 ns)`, naming the count
 *   asked for and the cap, before any sample runs it.
 */
export function recordWarmup(progress: WarmupProgress, spanMs: number): void {
  progress.samples += 1;
  if (progress.fixed === undefined) {
    progress.count = cappedCount(progress.count, spanMs, progress.stepMs);
  }
}

/**
 * Ends a warmup's bookkeeping.
 *
 * @param progress - The warmup's bookkeeping after its last sample.
 * @returns The count warmup ended on.
 */
export function warmedUp(progress: WarmupProgress): WarmupResult {
  return { callsPerSample: progress.count };
}

interface Timed<Context> {
  readonly now: () => number;
  readonly fn: (context: Context) => unknown;
  readonly context: Context;
}

/**
 * Holds what the last sample's last call returned, so the engine cannot treat the body's result as
 * dead. One store per sample, after the clock read: a store on every call costs about 2 ns per call
 * on Node and hides a deleted body from the empty-body check.
 */
const consumed: { value: unknown } = { value: undefined };

/**
 * Times `count` consecutive calls of the body on its context between one pair of clock reads, then
 * keeps what the last call returned until the next sample replaces it.
 *
 * @param timed - The clock, the body, and its context.
 * @param count - Calls in this sample.
 * @returns The span, in milliseconds.
 * @throws Whatever the body throws.
 */
function sample<Context>(timed: Timed<Context>, count: number): number {
  const { now, fn, context } = timed;
  let last: unknown;
  const started = now();
  for (let call = 0; call < count; call++) {
    last = fn(context);
  }
  const spanMs = now() - started;
  consumed.value = last;
  return spanMs;
}

/** What the shared-context warmup settles: its count, and the span a fixed count sizes the store by. */
interface SharedContextWarmup extends WarmupResult {
  /**
   * The shortest warmup sample that read a timer step, or one step when none did, in
   * milliseconds.
   */
  readonly shortestMs: number;
}

/**
 * Runs warmup samples until both 250 ms and 16 samples have passed, calibrating the count unless
 * one was fixed.
 *
 * @param timed - The clock, the body, and its context.
 * @param stepMs - The timer step, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on, and its shortest sample that read a step.
 * @throws Whatever the body throws, and Error when the count would pass the cap, before any
 *   sample runs it.
 */
function warmup<Context>(
  timed: Timed<Context>,
  stepMs: number,
  fixed: number | undefined,
): SharedContextWarmup {
  const { now } = timed;
  const progress = startWarmup(stepMs, fixed);
  let shortestMs = 0;
  const started = now();
  while (progress.samples < WARMUP_MIN_SAMPLES || now() - started < WARMUP_MIN_MS) {
    const spanMs = sample(timed, progress.count);
    shortestMs = shortestReadingStep(shortestMs, spanMs, stepMs);
    recordWarmup(progress, spanMs);
  }
  return { ...warmedUp(progress), shortestMs: shortestMs === 0 ? stepMs : shortestMs };
}

/** How a timing run ended. */
interface TimedRun {
  /** How many entries of the span store the run filled. */
  readonly stored: number;
  /** Whether the store filled before both `time` and `samples` had passed. */
  readonly cutShort: boolean;
}

/**
 * Fills `spans` with timed samples until both `time` and `samples` have passed, or `spans` is
 * full.
 *
 * @param timed - The clock, the body, and its context.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param minimums - The time, on the sampler's clock, and the samples the run must pass.
 * @returns How many entries of `spans` were filled, and whether the store filled first.
 * @throws Whatever the body throws.
 */
function timeSamples<Context>(
  timed: Timed<Context>,
  count: number,
  spans: Float64Array,
  minimums: TimedMinimums,
): TimedRun {
  const { now } = timed;
  const { time, samples } = minimums;
  let stored = 0;
  const started = now();
  while (stored < samples || now() - started < time) {
    if (stored === spans.length) {
      return { stored, cutShort: true };
    }
    spans[stored] = sample(timed, count);
    stored += 1;
  }
  return { stored, cutShort: false };
}

/**
 * Runs one timing run: the collection, the timed samples, then the after-timing callback.
 *
 * @param timed - The clock, the body, and its context.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param hooks - The `collect` callback that runs before the samples, the `afterTiming` callback
 *   that runs after the last sample, before the run is checked (absent means nothing), and the
 *   `time` and `samples` the run must pass.
 * @returns How many entries of `spans` were filled, and whether the store filled first.
 * @throws Whatever the body, `collect` or `afterTiming` throws.
 */
function timingRun<Context>(
  timed: Timed<Context>,
  count: number,
  spans: Float64Array,
  hooks: Pick<SharedContextOptions<Context>, "collect" | "afterTiming" | "time" | "samples">,
): TimedRun {
  hooks.collect();
  const run = timeSamples(timed, count, spans, hooks);
  hooks.afterTiming?.();
  return run;
}

/**
 * Whether a timing run keeps its spans: it passed `time` and `samples` before filling the store,
 * and its median sample (the upper median for an even count) spans at least 200 steps, counted as
 * warmup counts them.
 *
 * @param spans - The span store the run filled from its start.
 * @param run - How many entries the run filled, and whether the store filled first.
 * @param stepMs - The timer step, in milliseconds.
 * @returns `true` when the run is kept, `false` when it is discarded.
 */
function isKept(spans: Float64Array, run: TimedRun, stepMs: number): boolean {
  const { stored, cutShort } = run;
  if (cutShort) {
    return false;
  }
  const sorted = spans.subarray(0, stored).toSorted();
  const median = sorted[stored >> 1] ?? 0;
  return stepsIn(median, stepMs) >= MIN_STEPS_PER_SAMPLE;
}

/**
 * The count the timing run after a discarded one runs: the smallest at which the discarded run's
 * shortest sample would have spanned 200 steps, and at least one call more than it ran. Samples that
 * read no step are left out of the shortest.
 *
 * @param count - The count the discarded run ran.
 * @param spans - The discarded run's spans, in milliseconds.
 * @param stepMs - The timer step, in milliseconds.
 * @returns The next count, or 100 times `count` when no sample read a step.
 * @throws Error when the next count passes `ceil(200 × step / 0.1 ns)`, naming the count asked for
 *   and the cap.
 */
function grownCount(count: number, spans: Float64Array, stepMs: number): number {
  let shortest = 0;
  for (const span of spans) {
    shortest = shortestReadingStep(shortest, span, stepMs);
  }
  return withinCap(Math.max(calibratedCount(count, shortest, stepMs), count + 1), stepMs);
}

/**
 * Warms the body up, then times samples on the caller's one context in timing runs, collecting
 * before each.
 *
 * A run takes samples until both `time`, on the sampler's clock, and `samples` have passed, or the
 * span store is full. Unless the count was fixed, a run whose median sample spans under 200 steps,
 * or that filled the store first, is discarded: the count grows from its shortest sample and the
 * sampler times again, at most three runs in all. The check runs after `timeSamples` returns, never
 * inside the timing loop. A fixed-count run that fills the store is returned as it is.
 *
 * The span store holds `time` filled with samples of 200 steps for a calibrated count, or of
 * warmup's shortest sample that read a step for a fixed one (one step when none did), rounded up,
 * plus `samples`. It is allocated before the first collection, so its allocation never lands in a
 * timed sample. Every run refills it from the start.
 *
 * @param options - The body, its context, the collection, the callback after each run, `time` and
 *   `samples`, and the clock.
 * @returns The kept run's spans and calls per sample, and the timing runs taken.
 * @throws Whatever `fn`, `collect` or `afterTiming` throws; Error when warmup's or a grown count
 *   would pass `ceil(200 × step / 0.1 ns)`, naming the count asked for and the cap; and Error when
 *   the third run is discarded too, naming the count a fourth would need and the runs taken.
 */
export function sampleSharedContext<Context>(
  options: SharedContextOptions<Context>,
): SamplerResult {
  const { fn, context, callsPerSample } = options;
  const now = options.now ?? performanceNow;
  const stepMs = options.stepMs ?? timerStepMs(now);
  const timed: Timed<Context> = { now, fn, context };
  const warmed = warmup(timed, stepMs, callsPerSample);
  const spans = spanStore(
    options,
    callsPerSample === undefined ? calibratedSampleMs(stepMs) : warmed.shortestMs,
  );
  let calls = warmed.callsPerSample;
  let timingRuns = 1;
  let run = timingRun(timed, calls, spans, options);
  if (callsPerSample === undefined) {
    while (!isKept(spans, run, stepMs)) {
      calls = grownCount(calls, spans.subarray(0, run.stored), stepMs);
      if (timingRuns === MAX_TIMING_RUNS) {
        throw new Error(
          `${String(timingRuns)} timing runs were discarded; the next would need ${String(calls)} calls per sample`,
        );
      }
      run = timingRun(timed, calls, spans, options);
      timingRuns += 1;
    }
  }
  return { spans, samples: run.stored, callsPerSample: calls, timingRuns };
}
