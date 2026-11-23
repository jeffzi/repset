/**
 * Contest judgment: the entry of a contest, its contenders ranked and paired by the signed-rank
 * test on their timed repetitions, and the statistics it runs on: the exact signed-rank test, its
 * Hodges–Lehmann estimate and interval, and Holm's correction.
 */
import type { MeasuredTime } from "./child-protocol.js";
import type {
  CaseMeasurement,
  Contest,
  ContestContender,
  ContestPair,
  FailedResult,
  HeadlineTime,
  MeasuredResult,
  Result,
} from "./report.js";
import { ALPHA } from "./schedule.js";
import { pairsOf, valueAt } from "./utils.js";

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

/** The indices of `values`, ordered by ascending value. */
function ascendingOrder(values: readonly number[]): number[] {
  return [...values.keys()].toSorted(
    (left, right) => valueAt(values, left) - valueAt(values, right),
  );
}

/**
 * Ranks magnitudes from 1, equal magnitudes sharing their average rank, then doubles every rank so
 * an average of two ranks stays an integer.
 *
 * @param magnitudes - The magnitudes to rank.
 * @returns Each magnitude's doubled rank, in the input's order.
 */
function doubledRanks(magnitudes: readonly number[]): number[] {
  const order = ascendingOrder(magnitudes);
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
  const ordered = ascendingOrder(pValues);
  const adjusted = pValues.map(() => 1);
  let running = 0;
  for (const [step, index] of ordered.entries()) {
    const scaled = Math.min(1, (pValues.length - step) * valueAt(pValues, index));
    running = Math.max(running, scaled);
    adjusted[index] = running;
  }
  return adjusted;
}

/** How many timer resolutions per call a pair's ratio must clear past 1 to tell its contenders apart. */
const RESOLUTIONS = 1.25;

/** A measurement that timed its case. */
interface TimedMeasurement extends CaseMeasurement {
  readonly time: MeasuredTime;
}

/** A measured contender whose every measurement timed it, the only kind a contest is judged on. */
interface TimedResult extends MeasuredResult {
  readonly time: HeadlineTime;
  readonly measurements: readonly [TimedMeasurement, ...TimedMeasurement[]];
}

/** Whether `result` and each of its measurements hold a time. */
function isTimed(result: MeasuredResult): result is TimedResult {
  return result.time !== null && result.measurements.every(({ time }) => time !== null);
}

/** Two contenders of a contest, the signed-rank test of their repetitions, and whom it proves faster. */
interface Verdict {
  readonly a: TimedResult;
  readonly b: TimedResult;
  readonly p: number;
  readonly pAdjusted: number;
  readonly faster: TimedResult | null;
  readonly tie: ContestPair["tie"];
}

/** `repetitions` joined by commas, or `none` when it is empty. */
function listed(repetitions: readonly (number | null)[]): string {
  return repetitions.length === 0 ? "none" : repetitions.map(String).join(", ");
}

/**
 * The per-repetition `ln(median_b / median_a)` of two contenders that ran the same repetitions.
 *
 * @param a - The contender in the denominator.
 * @param b - The contender in the numerator.
 * @returns One log ratio per repetition, in `b`'s order.
 * @throws RangeError When a broken invariant has one contender run a repetition the other did not;
 *   the message names both contenders and the repetitions each ran alone.
 */
function logRatios(a: TimedResult, b: TimedResult): number[] {
  const medians = new Map(
    a.measurements.map(({ repetition, time }) => [repetition, time.stats.median]),
  );
  const differences: number[] = [];
  const onlyB: (number | null)[] = [];
  for (const { repetition, time } of b.measurements) {
    const median = medians.get(repetition);
    if (median === undefined) onlyB.push(repetition);
    else differences.push(Math.log(time.stats.median / median));
  }
  const ranByB = new Set(b.measurements.map(({ repetition }) => repetition));
  const onlyA = [...medians.keys()].filter((repetition) => !ranByB.has(repetition));
  if (onlyA.length > 0 || onlyB.length > 0) {
    throw new RangeError(
      `${a.id} and ${b.id} ran different repetitions: ${a.id} alone ran ${listed(onlyA)}; ` +
        `${b.id} alone ran ${listed(onlyB)}`,
    );
  }
  return differences;
}

/** A pair's ratio, the exp of the Hodges–Lehmann estimate of its per-repetition log ratios. */
function ratioOf(differences: readonly number[]): number {
  return Math.exp(hodgesLehmann(differences));
}

/** The largest timer resolution per call among both contenders' measurements, over the smaller median. */
function resolutionPerCall(a: TimedResult, b: TimedResult): number {
  const perCall = [...a.measurements, ...b.measurements].map(
    ({ time: { sampling } }) => sampling.timerResolutionNs / sampling.callsPerSample,
  );
  return Math.max(...perCall) / Math.min(a.time.median, b.time.median);
}

/** Why a pair has no verdict, or `null` when it is proven; see `ContestPair.tie`. */
function tieOf(
  pAdjusted: number,
  estimate: number,
  a: TimedResult,
  b: TimedResult,
): ContestPair["tie"] {
  if (pAdjusted > ALPHA) return "repetitions";
  const withinTimer = Math.exp(Math.abs(estimate)) - 1 <= RESOLUTIONS * resolutionPerCall(a, b);
  return withinTimer ? "timer" : null;
}

/**
 * Tests every pair of `measured`, adjusting the p values by Holm's over all of them.
 *
 * @param measured - The contenders that never failed.
 * @returns A verdict per pair; a pair is proven when its adjusted p is at most `ALPHA` and its
 *   ratio clears 1 by more than `RESOLUTIONS` timer resolutions per call.
 * @throws RangeError When two contenders ran different repetitions, or Holm's correction returns
 *   fewer p values than it was given.
 */
function verdictsOf(measured: readonly TimedResult[]): Verdict[] {
  const tested = measured.flatMap((a, index) =>
    measured.slice(index + 1).map((b) => {
      const differences = logRatios(a, b);
      return { a, b, p: signedRankP(differences), estimate: hodgesLehmann(differences) };
    }),
  );
  const adjusted = holm(tested.map(({ p }) => p));
  return tested.map(({ a, b, p, estimate }, index) => {
    const pAdjusted = valueAt(adjusted, index);
    const tie = tieOf(pAdjusted, estimate, a, b);
    const winner = estimate > 0 ? a : b;
    return { a, b, p, pAdjusted, faster: tie === null ? winner : null, tie };
  });
}

/**
 * The pair of a verdict, `a` the earlier contender in `order`.
 *
 * @param verdict - The verdict.
 * @param order - The contest's contenders that never failed, sorted.
 * @param level - The interval's confidence level.
 * @returns The pair's ratio, interval and verdict.
 * @throws RangeError When the pair's contenders ran different repetitions, or a broken invariant
 *   leaves the pair too few repetitions for an interval at `level`.
 */
function pairOf(verdict: Verdict, order: readonly TimedResult[], level: number): ContestPair {
  const [a, b] =
    order.indexOf(verdict.a) < order.indexOf(verdict.b)
      ? [verdict.a, verdict.b]
      : [verdict.b, verdict.a];
  const differences = logRatios(a, b);
  const [low, high] = signedRankInterval(differences, level);
  return {
    a: a.id,
    b: b.id,
    ratio: ratioOf(differences),
    interval: [Math.exp(low), Math.exp(high)],
    p: verdict.p,
    pAdjusted: verdict.pAdjusted,
    faster: verdict.faster?.id ?? null,
    tie: verdict.tie,
  };
}

/** The entry of a contender, its `time` and `memory` its result's. */
function contenderOf(
  result: Result,
  ratio: number | null = null,
  rank: number | null = null,
): ContestContender {
  return { id: result.id, time: result.time, memory: result.memory, ratio, rank };
}

/**
 * Judges a contest from its contenders' results. A contest left with fewer than two contenders
 * that never failed, whose contenders were not timed, or whose repetitions `n` fail
 * `2 / 2ⁿ ≤ 0.05 / pairs`, is not judged.
 *
 * @param results - The contest's results on one runtime, in the order they were emitted.
 * @returns The contest's entry; when it is not judged, its contenders hold their times and memory
 *   with a `null` rank and ratio, and its `pairs` is empty.
 * @throws RangeError When two timed contenders of a judged contest ran different repetitions, the
 *   message naming both and the repetitions each ran alone, or when a broken invariant leaves a
 *   judged pair too few repetitions for its interval's level.
 */
export function contestOf(results: readonly [Result, ...Result[]]): Contest {
  const [{ name, runtime }] = results;
  const repetitionCount = Math.max(
    ...results.flatMap(({ measurements }) =>
      measurements.flatMap(({ repetition }) => (repetition === null ? [] : [repetition])),
    ),
  );
  const measured = results.filter((result): result is MeasuredResult => result.status === "ok");
  const timed = measured.filter(isTimed);
  const failed = results
    .filter((result): result is FailedResult => result.status === "failed")
    .map((result) => contenderOf(result));
  const pairCount = pairsOf(timed.length);
  const head = { name, params: {}, runtime, repetitionCount };
  const smallestP = 2 / 2 ** repetitionCount;
  const tooFewRepetitions = smallestP > ALPHA / pairCount;
  const notTimed = timed.length < measured.length;
  if (notTimed || timed.length < 2 || tooFewRepetitions) {
    const sorted: readonly MeasuredResult[] = notTimed
      ? measured
      : timed.toSorted((left, right) => left.time.median - right.time.median);
    const contenders = sorted.map((result) => contenderOf(result));
    return { ...head, contenders: [...contenders, ...failed], pairs: [] };
  }
  const verdicts = verdictsOf(timed);
  const rankOf = (result: TimedResult): number =>
    1 +
    verdicts.filter(
      ({ a, b, faster }) => (a === result || b === result) && faster !== null && faster !== result,
    ).length;
  const ranked = timed
    .map((result) => ({ result, rank: rankOf(result) }))
    .toSorted((left, right) =>
      left.rank === right.rank
        ? left.result.time.median - right.result.time.median
        : left.rank - right.rank,
    );
  const order = ranked.map(({ result }) => result);
  const position = (id: string): number => order.findIndex((result) => result.id === id);
  const pairs = verdicts
    .map((verdict) => pairOf(verdict, order, 1 - ALPHA / pairCount))
    .toSorted((left, right) =>
      left.a === right.a
        ? position(left.b) - position(right.b)
        : position(left.a) - position(right.a),
    );
  const fastest = valueAt(order, 0);
  const contenders = ranked.map(({ result, rank }) =>
    contenderOf(result, result === fastest ? 1 : ratioOf(logRatios(fastest, result)), rank),
  );
  return { ...head, contenders: [...contenders, ...failed], pairs };
}
