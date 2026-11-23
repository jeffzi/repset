/**
 * Contest judgment: the entry of a contest, its contenders ranked and paired by the signed-rank
 * test on their timed repetitions.
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
import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "./signed-rank.js";
import { pairsOf, valueAt } from "./utils.js";

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

/** The per-repetition `ln(median_b / median_a)` over the repetitions both contenders ran. */
function logRatios(a: TimedResult, b: TimedResult): number[] {
  const medians = new Map(
    a.measurements.map(({ repetition, time }) => [repetition, time.stats.median]),
  );
  return b.measurements.flatMap(({ repetition, time }) => {
    const median = medians.get(repetition);
    return median === undefined ? [] : [Math.log(time.stats.median / median)];
  });
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
    ratio: Math.exp(hodgesLehmann(differences)),
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
 * `2 / 2ⁿ ≤ 0.05 / pairs`, is not judged: its entry holds the times and memory and no rank, ratio
 * or pair.
 *
 * @param results - The contest's results on one runtime, in the order they were emitted.
 * @returns The contest's entry.
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
  const [fastest] = order;
  const contenders = ranked.map(({ result, rank }) =>
    contenderOf(
      result,
      result === fastest
        ? 1
        : (pairs.find((pair) => pair.a === fastest?.id && pair.b === result.id)?.ratio ?? null),
      rank,
    ),
  );
  return { ...head, contenders: [...contenders, ...failed], pairs };
}
