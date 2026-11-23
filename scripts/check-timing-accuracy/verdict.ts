import { medianOf } from "../../src/run.js";
import { valueAt } from "../../src/utils.js";

/**
 * Per-process medians (ns) from one round of back-to-back pairs; `baseline[i]` pairs with
 * `repset[i]`, and `perCallResolutions[i]` is that pair's per-call resolution: the timer's
 * resolution divided by the smaller of the pair's two calls per sample.
 */
export interface Pairs {
  readonly baseline: readonly number[];
  readonly repset: readonly number[];
  readonly perCallResolutions: readonly number[];
}

/**
 * One round of a scenario, reduced to its medians, relative gap, sign-flip p-value, and the mean
 * (ns) of the paired differences the p-value tested, ties counted as 0.
 */
export interface RoundSummary {
  readonly baselineMedian: number;
  readonly repsetMedian: number;
  readonly gap: number;
  readonly pValue: number;
  readonly meanDifference: number;
}

/** Outcome of one scenario: the first round, plus the confirmation round when one was taken. */
export interface ScenarioVerdict {
  readonly passed: boolean;
  readonly first: RoundSummary;
  readonly confirmation?: RoundSummary;
}

const SIGNIFICANCE = 0.05;

// Signed sums that are mathematically equal to the observed sum can land just below it, depending
// on summation order. Without this relative slack those ties drop out and p reads too small.
const TIE_TOLERANCE = 1e-9;

// Two medians of the same number of timer resolutions can differ in their last digits, since each
// is a difference of two clock reads. A median is a whole number of timer resolutions over the
// calls per sample, or the mean of two such spans, so medians taken at one count that really differ
// sit at least half a per-call resolution (`Pairs.perCallResolutions`) apart. Medians at two counts
// c1 < c2 that really differ sit at least resolution / (2 * c1 * c2) apart, still above a millionth
// of the per-call resolution while c2 stays under 500,000 calls. A pair within a millionth of its
// per-call resolution is a tie.
const RESOLUTION_TIE_FRACTION = 1e-6;

/**
 * The paired difference, with near-ties counted as 0.
 *
 * @param baseline - The baseline median.
 * @param repset - The repset median.
 * @param perCallResolution - The pair's per-call resolution; differences within a millionth of it
 * count as a tie.
 * @returns `repset - baseline`, or 0 for a tie.
 */
function pairedDifference(baseline: number, repset: number, perCallResolution: number): number {
  const difference = repset - baseline;
  return Math.abs(difference) <= perCallResolution * RESOLUTION_TIE_FRACTION ? 0 : difference;
}

function signFlipPValue(differences: readonly number[], observedSum: number): number {
  let signedSums = [0];
  for (const difference of differences) {
    signedSums = signedSums.flatMap((sum) => [sum + difference, sum - difference]);
  }
  const observed = Math.abs(observedSum);
  const threshold = observed - observed * TIE_TOLERANCE;
  const extreme = signedSums.filter((sum) => Math.abs(sum) >= threshold).length;
  return extreme / signedSums.length;
}

/**
 * @param pairs - The round's paired medians and each pair's per-call resolution.
 * @returns The round's summary. The sign of its `meanDifference` is the direction the p-value
 * tested: positive when repset reads higher, negative when lower, zero when the paired differences
 * sum to nothing, which never happens at p < 0.05.
 * @throws RangeError when `pairs.baseline` is empty or the three arrays differ in length.
 */
function summarizeRound(pairs: Pairs): RoundSummary {
  const { baseline, repset, perCallResolutions } = pairs;
  if (baseline.length !== repset.length || baseline.length !== perCallResolutions.length) {
    throw new RangeError(
      `expected paired values, got ${baseline.length} baseline, ${repset.length} repset and ${perCallResolutions.length} per-call resolutions`,
    );
  }
  const baselineMedian = medianOf(baseline);
  const repsetMedian = medianOf(repset);
  const differences = repset.map((repsetValue, index) =>
    pairedDifference(valueAt(baseline, index), repsetValue, valueAt(perCallResolutions, index)),
  );
  const observedSum = differences.reduce((sum, difference) => sum + difference, 0);
  return {
    baselineMedian,
    repsetMedian,
    gap: (repsetMedian - baselineMedian) / baselineMedian,
    pValue: signFlipPValue(differences, observedSum),
    meanDifference: observedSum / differences.length,
  };
}

/**
 * Judge one scenario, confirming a significant first round with a confirmation round.
 *
 * A first round at p >= 0.05 passes outright and `confirmationRound` is never called. Otherwise the
 * scenario fails only when the confirmation round alone reads p < 0.05 with its paired differences
 * summing to the same sign as the first round's. The direction is the sign the p-value tested,
 * never the gap's: the two sides' medians can tie while most pairs differ one way.
 *
 * @param first - The scenario's first round of pairs.
 * @param confirmationRound - Produces a new round of pairs; called at most once.
 * @returns The verdict, carrying the confirmation summary only when a confirmation round was taken.
 * @throws RangeError when a round's arrays are empty or differ in length; any error from
 * `confirmationRound` propagates.
 */
export function judgeScenario(first: Pairs, confirmationRound: () => Pairs): ScenarioVerdict {
  const firstSummary = summarizeRound(first);
  if (firstSummary.pValue >= SIGNIFICANCE) {
    return { passed: true, first: firstSummary };
  }
  const confirmationSummary = summarizeRound(confirmationRound());
  const differenceConfirmed =
    confirmationSummary.pValue < SIGNIFICANCE &&
    Math.sign(confirmationSummary.meanDifference) === Math.sign(firstSummary.meanDifference);
  return { passed: !differenceConfirmed, first: firstSummary, confirmation: confirmationSummary };
}
