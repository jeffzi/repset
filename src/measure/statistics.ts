export const NS_PER_MS = 1_000_000;

/** Per-call statistics of the timed samples in nanoseconds, named as the report prints them. */
export interface Statistics {
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  readonly samples: number;
}

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
  const lower = Math.floor(position);
  const low = timeAt(sorted, lower);
  const high = timeAt(sorted, Math.ceil(position));
  return low + (high - low) * (position - lower);
}

/**
 * Summarizes a sampler's timed spans as per-call statistics in nanoseconds.
 *
 * The spans may be stored in any order; the store itself is left untouched.
 *
 * @param spansMs - The sampler's span store: each timed sample's span in milliseconds, for
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
  return {
    min: quantile(sorted, 0),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p99: quantile(sorted, 0.99),
    max: quantile(sorted, 1),
    mean: total / sorted.length,
    samples: sorted.length,
  };
}
