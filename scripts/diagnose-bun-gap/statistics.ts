/**
 * The statistics the Bun gap diagnosis's analysis reports: paired intervals, speed levels and the
 * two-proportion test.
 */
import { valueAt } from "../../src/utils.js";

/** The mean of paired differences and its 95 % interval. */
export interface Interval {
  n: number;
  mean: number;
  low: number;
  high: number;
}

const Z_95 = 1.96;

/**
 * Computes the mean of paired differences and its 95 % interval, mean ± 1.96 × sd/√n with sd the
 * sample standard deviation.
 *
 * @param differences - One difference per pair.
 * @returns The pair count, the mean and the interval's bounds; the bounds are NaN under two pairs.
 */
export function pairedInterval(differences: readonly number[]): Interval {
  const n = differences.length;
  const mean = differences.reduce((total, value) => total + value, 0) / n;
  const variance = differences.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1);
  const half = Z_95 * Math.sqrt(variance / n);
  return { n, mean, low: mean - half, high: mean + half };
}

/**
 * Splits values into speed levels: sorted, a new level starts wherever two neighbors differ by
 * more than the gap.
 *
 * @param values - The values to split, in any order.
 * @param gap - The largest difference between neighbors on one level.
 * @returns The ascending cuts, each midway between the two neighbors it separates; a value above
 *   `k` cuts sits on level `k`.
 */
export function levelCuts(values: readonly number[], gap: number): number[] {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.slice(1).flatMap((high, index) => {
    const low = valueAt(sorted, index);
    return high - low > gap ? [(low + high) / 2] : [];
  });
}

/** The speed level `value` sits on: how many of `cuts` it lies above. */
export function levelOf(value: number, cuts: readonly number[]): number {
  return cuts.filter((cut) => value > cut).length;
}

/**
 * The complementary error function for x ≥ 0, to 1.5e-7: Handbook of Mathematical Functions,
 * formula 7.1.26.
 */
function complementaryError(x: number): number {
  const t = 1 / (1 + 0.327_591_1 * x);
  const poly =
    t *
    (0.254_829_592 +
      t * (-0.284_496_736 + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
  return poly * Math.exp(-x * x);
}

/**
 * Tests whether two shares differ, with the two-sided two-proportion z-test on the pooled
 * proportion.
 *
 * @param offA - The count of hits in the first sample.
 * @param totalA - The size of the first sample.
 * @param offB - The count of hits in the second sample.
 * @param totalB - The size of the second sample.
 * @returns The p-value; 1 when the pooled proportion is 0 or 1, as no difference is possible.
 */
export function twoProportionP(offA: number, totalA: number, offB: number, totalB: number): number {
  const pooled = (offA + offB) / (totalA + totalB);
  if (pooled === 0 || pooled === 1) {
    return 1;
  }
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  const z = (offA / totalA - offB / totalB) / standardError;
  return complementaryError(Math.abs(z) / Math.SQRT2);
}
