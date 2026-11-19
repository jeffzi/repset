/** The exact signed-rank test, its Hodges–Lehmann estimate and interval, and Holm's correction. */
import { valueAt } from "./utils.js";

/**
 * The null distribution of the sum of the positive weights when each weight's sign is a fair coin
 * flip. Each weight halves the probabilities so far, and halving a double is exact, so the
 * probabilities are the exact counts of sign assignments over 2^n for as many weights as a double
 * holds those counts exactly, and the sum cannot overflow at any count.
 *
 * @param weights - Nonnegative integer weights.
 * @returns `mass[t]`, the probability that the positive weights sum to `t`.
 */
function nullDistribution(weights: readonly number[]): number[] {
  let mass = [1];
  for (const weight of weights) {
    const share = mass.map((probability) => probability / 2);
    const next = [...share, ...Array.from({ length: weight }, () => 0)];
    for (const [sum, probability] of share.entries())
      next[sum + weight] = valueAt(next, sum + weight) + probability;
    mass = next;
  }
  return mass;
}

/**
 * Ranks magnitudes from 1, equal magnitudes sharing their average rank, then doubles every rank so
 * an average of two ranks stays an integer.
 *
 * @param magnitudes - The magnitudes to rank.
 * @returns Each magnitude's doubled rank, in the input's order.
 */
function doubledRanks(magnitudes: readonly number[]): number[] {
  const order = [...magnitudes.keys()].toSorted(
    (left, right) => valueAt(magnitudes, left) - valueAt(magnitudes, right),
  );
  const ranks = magnitudes.map(() => 0);
  let start = 0;
  while (start < order.length) {
    const magnitude = valueAt(magnitudes, valueAt(order, start));
    let end = start;
    while (end + 1 < order.length && valueAt(magnitudes, valueAt(order, end + 1)) === magnitude) {
      end += 1;
    }
    for (let position = start; position <= end; position += 1) {
      ranks[valueAt(order, position)] = start + end + 2;
    }
    start = end + 1;
  }
  return ranks;
}

/**
 * The two-sided exact signed-rank p value. Zero differences are dropped, and equal magnitudes
 * share their average rank; the null distribution is the exact one of those ranks.
 *
 * @param differences - The paired differences.
 * @returns The p value, 1 when no difference is nonzero.
 */
export function signedRankP(differences: readonly number[]): number {
  const nonzero = differences.filter((difference) => difference !== 0);
  if (nonzero.length === 0) return 1;
  const ranks = doubledRanks(nonzero.map((difference) => Math.abs(difference)));
  const observed = ranks.reduce(
    (sum, rank, index) => (valueAt(nonzero, index) > 0 ? sum + rank : sum),
    0,
  );
  let lower = 0;
  let upper = 0;
  for (const [sum, probability] of nullDistribution(ranks).entries()) {
    if (sum <= observed) lower += probability;
    if (sum >= observed) upper += probability;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}

/** The Walsh averages `(d_i + d_j) / 2`, `i ≤ j`, of `differences`, ascending. */
function walshAverages(differences: readonly number[]): number[] {
  const averages: number[] = [];
  for (const [index, left] of differences.entries()) {
    for (const right of differences.slice(index)) averages.push((left + right) / 2);
  }
  return averages.toSorted((left, right) => left - right);
}

/**
 * The Hodges–Lehmann estimate: the median of the Walsh averages of every difference, zeros
 * included.
 *
 * @param differences - The paired differences.
 * @returns The estimate.
 * @throws RangeError When `differences` is empty.
 */
export function hodgesLehmann(differences: readonly number[]): number {
  const averages = walshAverages(differences);
  const middle = averages.length - 1;
  return (valueAt(averages, Math.floor(middle / 2)) + valueAt(averages, Math.ceil(middle / 2))) / 2;
}

/**
 * The exact confidence interval of the Hodges–Lehmann estimate: the Walsh averages of rank `C` and
 * `M + 1 − C` among the `M` of every difference, zeros included, where `C` is the largest count
 * with `2 · P(T ≤ C − 1) ≤ 1 − level` under the untied null of the signed-rank statistic `T` for
 * that many differences. Tied magnitudes keep the untied null.
 *
 * @param differences - The paired differences.
 * @param level - The confidence level, as 0.95 for 95%.
 * @returns The interval's low and high ends.
 * @throws RangeError When no Walsh average reaches `level`: too few differences for it.
 */
export function signedRankInterval(
  differences: readonly number[],
  level: number,
): readonly [number, number] {
  let critical = 0;
  let cumulative = 0;
  for (const probability of nullDistribution(Array.from(differences, (_, index) => index + 1))) {
    cumulative += probability;
    if (2 * cumulative > 1 - level) break;
    critical += 1;
  }
  if (critical === 0) {
    throw new RangeError(
      `no interval reaches level ${level} with ${differences.length} differences`,
    );
  }
  const averages = walshAverages(differences);
  return [valueAt(averages, critical - 1), valueAt(averages, averages.length - critical)];
}

/**
 * Holm's adjusted p values: over the raw p values in ascending order, each one times the count of
 * p values from it to the largest, raised to the largest adjusted value before it and capped at 1.
 *
 * @param pValues - The raw p values of one family.
 * @returns The adjusted p values, in the input's order.
 */
export function holm(pValues: readonly number[]): number[] {
  const ordered = [...pValues.keys()].toSorted(
    (left, right) => valueAt(pValues, left) - valueAt(pValues, right),
  );
  const adjusted = pValues.map(() => 1);
  let running = 0;
  for (const [step, index] of ordered.entries()) {
    const scaled = Math.min(1, (pValues.length - step) * valueAt(pValues, index));
    running = Math.max(running, scaled);
    adjusted[index] = running;
  }
  return adjusted;
}
