/**
 * The per-call sampler: for a body that consumes its context, so every call runs on a fresh one.
 * Each call builds a context, runs the body once on it between a pair of clock reads, then tears it
 * down; a sample's span is the sum of its calls' spans, so no setup or teardown lands inside one.
 * Spans are in milliseconds. The result is `sampleSharedContext`'s `SamplerResult`, and `collect`,
 * `now`, `stepMs` and `callsPerSample` mean what they mean there, except that `collect` runs once:
 * this sampler takes a single timing run.
 *
 * Every function from `samplePerCall` down to the body is plain synchronous code: no `try`,
 * `catch`, `finally`, `async` function, generator or Promise encloses the timed calls or the loops
 * around them (VISION #1), since any of those changes how the engine compiles the loop. Error
 * handling and teardown on a throw belong to the caller, which finds the context in flight in
 * `slots`.
 *
 * The module imports only sibling `measure` modules and reads no Node builtin, so it loads in a
 * browser page.
 */

import {
  calibratedSampleMs,
  recordWarmup,
  spanStore,
  startWarmup,
  warmedUp,
  WARMUP_MIN_SAMPLES,
  type SamplerClock,
  type SamplerResult,
  type Sampling,
  type TimedMinimums,
  type WarmupResult,
} from "./shared-context.js";
import { performanceNow, timerStepMs } from "./timer.js";

const WARMUP_MIN_MS = 3000;
const WARMUP_MAX_SAMPLES = 1000;

/** `now` defaults to `performance.now()`, and `stepMs` to a probe of `now`. */
export interface PerCallOptions<Context>
  extends Omit<Sampling, "now" | "stepMs">, SamplerClock, TimedMinimums {
  /** Builds the fresh context one body call consumes. */
  readonly setup: () => Context;
  /** The benchmark body; every call receives a context built for it alone. */
  readonly fn: (context: Context) => void;
  /** Tears down a context once its body call returned; defaults to doing nothing. */
  readonly teardown?: (context: Context) => void;
  /**
   * Holds every context built and not yet torn down: the sampler sets an entry on setup and
   * clears it to `undefined` on teardown, so a caller that catches a throw from the sampler can
   * tear down whatever is left.
   */
  readonly slots?: (Context | undefined)[];
}

interface PerCall<Context> {
  readonly now: () => number;
  readonly setup: () => Context;
  readonly fn: (context: Context) => void;
  readonly teardown: (context: Context) => void;
  readonly slots: (Context | undefined)[];
}

/** The teardown of a benchmark that gives none. */
export function keep(): void {
  // A context without a teardown is left to the garbage collector.
}

/**
 * Times `count` body calls, each on a context built just before its clock reads and torn down
 * just after.
 *
 * @param perCall - The clock, the lifecycle, and the slots that hold the context in flight.
 * @param count - Calls in this sample.
 * @returns The sum of the calls' spans, in milliseconds.
 * @throws Whatever `setup`, `fn` or `teardown` throws, leaving the context in flight in
 *   `perCall.slots`.
 */
function sample<Context>(perCall: PerCall<Context>, count: number): number {
  const { now, setup, fn, teardown, slots } = perCall;
  let summed = 0;
  for (let call = 0; call < count; call++) {
    const context = setup();
    slots[0] = context;
    const started = now();
    fn(context);
    summed += now() - started;
    teardown(context);
    slots[0] = undefined;
  }
  return summed;
}

/**
 * Runs warmup samples until 1000 have run, or until both 3000 ms of wall time, every setup and
 * teardown included, and 16 samples have passed, calibrating the count unless one was fixed.
 *
 * @param perCall - The clock, the lifecycle, and the slots.
 * @param stepMs - The timer step, in milliseconds.
 * @param fixed - The fixed calls per sample, or `undefined` to calibrate one.
 * @returns The count warmup ended on.
 * @throws Whatever `setup`, `fn` or `teardown` throws, and Error when the calibrated count would
 *   pass `ceil(200 × step / 0.1 ns)`, naming the count asked for and the cap, before any sample
 *   runs it.
 */
function warmup<Context>(
  perCall: PerCall<Context>,
  stepMs: number,
  fixed: number | undefined,
): WarmupResult {
  const { now } = perCall;
  const progress = startWarmup(stepMs, fixed);
  const started = now();
  let elapsedMs = 0;
  while (
    progress.samples < WARMUP_MAX_SAMPLES &&
    (progress.samples < WARMUP_MIN_SAMPLES || elapsedMs < WARMUP_MIN_MS)
  ) {
    const spanMs = sample(perCall, progress.count);
    elapsedMs = now() - started;
    recordWarmup(progress, spanMs);
  }
  return warmedUp(progress);
}

/**
 * Fills `spans` with timed samples until it is full, or until both `time` of wall time, every
 * setup and teardown included, and `samples` have passed.
 *
 * @param perCall - The clock, the lifecycle, and the slots.
 * @param count - Calls per sample.
 * @param spans - Preallocated storage for the spans, in milliseconds.
 * @param minimums - The wall time and the samples the run must pass.
 * @returns How many entries of `spans` were filled.
 * @throws Whatever `setup`, `fn` or `teardown` throws.
 */
function timeSamples<Context>(
  perCall: PerCall<Context>,
  count: number,
  spans: Float64Array,
  minimums: TimedMinimums,
): number {
  const { now } = perCall;
  const { time, samples } = minimums;
  const capacity = spans.length;
  let stored = 0;
  const started = now();
  let elapsedMs = 0;
  while (stored < capacity && (stored < samples || elapsedMs < time)) {
    spans[stored] = sample(perCall, count);
    elapsedMs = now() - started;
    stored += 1;
  }
  return stored;
}

/**
 * Warms a perCall body up, collects once, then times every sample, each call on a fresh context.
 *
 * The collection builds one context, runs the body on it outside any clock read, calls `collect`
 * while it is alive, then tears it down. Timing takes samples until both `time`, in wall time with
 * every setup and teardown, and `samples` have passed, or the span store is full; a run that fills
 * the store is returned as it is. The store holds `time` filled with 200-step samples, rounded up,
 * plus `samples`, whether or not the count was fixed, and is allocated before the collection, so
 * its allocation never lands in a timed sample. No two contexts are ever alive at once.
 *
 * @param options - The lifecycle, the collection, the slots, `time` and `samples`, and the clock.
 * @returns The timed spans, the calls per sample, and `timingRuns` of 1: this
 *   sampler never checks a timing run or times again.
 * @throws Whatever `setup`, `fn`, `teardown` or `collect` throws, leaving every context built and
 *   not torn down in `options.slots`; and Error when warmup's calibrated count would pass
 *   `ceil(200 × step / 0.1 ns)`, naming the count asked for and the cap, before any sample runs it.
 */
export function samplePerCall<Context>(options: PerCallOptions<Context>): SamplerResult {
  const { setup, fn, collect, callsPerSample } = options;
  const now = options.now ?? performanceNow;
  const stepMs = options.stepMs ?? timerStepMs(now);
  const teardown = options.teardown ?? keep;
  const slots = options.slots ?? [];
  const perCall: PerCall<Context> = { now, setup, fn, teardown, slots };
  const warmed = warmup(perCall, stepMs, callsPerSample);
  const spans = spanStore(options, calibratedSampleMs(stepMs));
  const held = setup();
  slots[0] = held;
  fn(held);
  collect();
  teardown(held);
  slots[0] = undefined;
  const samples = timeSamples(perCall, warmed.callsPerSample, spans, options);
  return {
    spans,
    samples,
    callsPerSample: warmed.callsPerSample,
    timingRuns: 1,
  };
}
