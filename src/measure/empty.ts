/**
 * The empty run: times a body that does nothing, in a benchmark's own lifecycle, so `measure` can
 * tell a body from the loop around it. Spans are in milliseconds.
 *
 * Its loops are functions of their own, never `sampleSharedContext` or `samplePerCall`: on Node, a
 * sampling loop that has already run the body reads the empty body about six times slow. The loops
 * keep the shape of the body's samplers, so they time what the body's loops cost.
 *
 * Like the samplers, the module imports no Node builtin, so it loads in a browser page.
 */

import {
  cappedCount,
  WARMUP_MIN_SAMPLES,
  type SamplerResult,
  type Sampling,
} from "./shared-context.js";

/** The empty run's timed samples, whatever `time` and `samples` the body ran on. */
const TIMED_SAMPLES = 64;

/** The empty body the body's reading is compared against. */
export function empty(): void {
  // Times the sampling loop alone.
}

/** The empty run's timed spans and the calls per sample they ran. */
export type EmptyResult = Pick<SamplerResult, "spans" | "samples" | "callsPerSample">;

/** How a benchmark builds the context its body runs on: one shared by every call, or one per call. */
export type Lifecycle = "sharedContext" | "perCall";

export interface EmptyOptions extends Sampling {
  /** `sharedContext` times batched calls between one pair of clock reads; `perCall` sums per-call spans. */
  readonly kind: Lifecycle;
}

// The empty body is reached through `fn`, as the samplers reach theirs, so these loops compile
// as theirs do.
interface Timed {
  readonly now: () => number;
  readonly fn: () => unknown;
}

/** Holds what the batched loop's last empty call returned, as the shared-context sampler does. */
const consumed: { value: unknown } = { value: undefined };

/**
 * Times `count` consecutive empty calls between one pair of clock reads, then keeps what the last
 * call returned, as a shared-context sample does.
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
 * Times the empty body: 16 warmup samples that calibrate the count unless one is fixed, one
 * collection, then 64 timed samples.
 *
 * @param options - The lifecycle to time it in, the clock, its step, the collection, and the fixed
 *   count if one was given.
 * @returns The 64 timed spans and the calls per sample they ran.
 * @throws Whatever `collect` throws, and BudgetError when warmup's count would pass
 *   `ceil(200 × step / 0.1 ns)`, naming the count asked for and the cap.
 */
export function sampleEmpty(options: EmptyOptions): EmptyResult {
  const { kind, now, stepMs, collect, callsPerSample } = options;
  const span = kind === "sharedContext" ? batched : summed;
  const timed: Timed = { now, fn: empty };
  let count = callsPerSample ?? 1;
  for (let samples = 0; samples < WARMUP_MIN_SAMPLES; samples++) {
    const spanMs = span(timed, count);
    if (callsPerSample === undefined) {
      count = cappedCount(count, spanMs, stepMs);
    }
  }
  const spans = new Float64Array(TIMED_SAMPLES);
  collect();
  for (let stored = 0; stored < spans.length; stored++) {
    spans[stored] = span(timed, count);
  }
  return { spans, samples: spans.length, callsPerSample: count };
}
