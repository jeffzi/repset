/** Per-process medians (ns) from one round of back-to-back pairs; `plain[i]` pairs with `repset[i]`. */
export interface Pairs {
  readonly plain: readonly number[];
  readonly repset: readonly number[];
}

/** One round of a cell, reduced to its medians, relative gap, and sign-flip p-value. */
export interface CellSummary {
  readonly plainMedian: number;
  readonly repsetMedian: number;
  readonly gap: number;
  readonly pValue: number;
}

/** Outcome of one cell: the first round, plus the confirmation round when one was taken. */
export interface CellVerdict {
  readonly passed: boolean;
  readonly first: CellSummary;
  readonly confirmation?: CellSummary;
}

const SIGNIFICANCE = 0.05;

// Float rounding makes two equal values read as different, and without this relative slack p
// reads too small:
//
// - Two medians of the same number of clock ticks can differ in their last digits, since each is
//   a difference of two clock reads, so a pair that ties reads as a difference.
// - Signed sums that are mathematically equal to the observed sum can land just below it,
//   depending on summation order, so those ties drop out.
const TIE_TOLERANCE = 1e-9;

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} is outside ${values.length} values`);
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const lower = at(sorted, Math.floor((sorted.length - 1) / 2));
  const upper = at(sorted, Math.floor(sorted.length / 2));
  return (lower + upper) / 2;
}

/** `repset - plain`, or 0 when the two differ by no more than float rounding. */
function pairedDifference(plain: number, repset: number): number {
  const difference = repset - plain;
  const larger = Math.max(Math.abs(plain), Math.abs(repset));
  return Math.abs(difference) <= larger * TIE_TOLERANCE ? 0 : difference;
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
 * Summarizes one round, keeping the direction the p-value tested.
 *
 * @param pairs - The round's paired medians.
 * @returns The round's summary, and the sign of the summed paired differences: 1 when repset
 * reads higher, -1 when lower, 0 when they sum to nothing. It is never 0 at p < 0.05.
 * @throws RangeError when `pairs.plain` is empty or the two arrays differ in length.
 */
function summarizeRound(pairs: Pairs): {
  readonly summary: CellSummary;
  readonly direction: number;
} {
  const { plain, repset } = pairs;
  if (plain.length !== repset.length) {
    throw new RangeError(
      `expected paired values, got ${plain.length} plain and ${repset.length} repset`,
    );
  }
  const plainMedian = median(plain);
  const repsetMedian = median(repset);
  const differences = repset.map((repsetValue, index) =>
    pairedDifference(at(plain, index), repsetValue),
  );
  const observedSum = differences.reduce((sum, difference) => sum + difference, 0);
  return {
    summary: {
      plainMedian,
      repsetMedian,
      gap: (repsetMedian - plainMedian) / plainMedian,
      pValue: signFlipPValue(differences, observedSum),
    },
    direction: Math.sign(observedSum),
  };
}

/**
 * Summarize one round of paired medians.
 *
 * The p-value is the two-sided sign-flip permutation test on `repset[i] - plain[i]`, enumerated
 * exactly over all 2^n sign assignments, so the cost doubles with every pair. A pair whose two
 * medians differ by no more than float rounding counts as a tie, a difference of 0.
 *
 * @param plain - Per-process medians from the hand-written plain loop.
 * @param repset - Per-process medians from repset, paired index by index with `plain`.
 * @returns The median of each side, the gap `(repset - plain) / plain` between those medians, and
 * the fraction of sign assignments whose absolute signed sum reaches the observed one.
 * @throws RangeError when `plain` is empty or the two arrays differ in length.
 */
export function summarizeCell(plain: readonly number[], repset: readonly number[]): CellSummary {
  return summarizeRound({ plain, repset }).summary;
}

/**
 * Judge one cell, confirming a significant first round with a fresh one.
 *
 * A first round at p >= 0.05 passes outright and `freshRound` is never called. Otherwise the cell
 * fails only when the fresh round alone reads p < 0.05 with its paired differences summing to the
 * same sign as the first round's. The direction is the sign the p-value tested, never the gap's:
 * the two sides' medians can tie while most pairs differ one way.
 *
 * @param first - The cell's first round of pairs.
 * @param freshRound - Produces a new round of pairs; called at most once.
 * @returns The verdict, carrying the confirmation summary only when a fresh round was taken.
 * @throws RangeError when a round's arrays are empty or differ in length; any error from
 * `freshRound` propagates.
 */
export async function judgeCell(
  first: Pairs,
  freshRound: () => Pairs | Promise<Pairs>,
): Promise<CellVerdict> {
  const firstRound = summarizeRound(first);
  if (firstRound.summary.pValue >= SIGNIFICANCE) {
    return { passed: true, first: firstRound.summary };
  }
  const confirmation = summarizeRound(await freshRound());
  const differenceConfirmed =
    confirmation.summary.pValue < SIGNIFICANCE && confirmation.direction === firstRound.direction;
  return {
    passed: !differenceConfirmed,
    first: firstRound.summary,
    confirmation: confirmation.summary,
  };
}

/**
 * Process exit status for a set of cell verdicts.
 *
 * @param verdicts - Every cell's verdict.
 * @returns 1 when any cell failed, 0 otherwise.
 */
export function exitStatus(verdicts: readonly CellVerdict[]): 0 | 1 {
  return verdicts.some((verdict) => !verdict.passed) ? 1 : 0;
}
