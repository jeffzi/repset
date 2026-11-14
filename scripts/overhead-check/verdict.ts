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

// Signed sums that are mathematically equal to the observed sum can land just below it through
// float rounding, depending on summation order; without this slack those ties drop out and p
// reads too small.
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

function signFlipPValue(differences: readonly number[]): number {
  let signedSums = [0];
  for (const difference of differences) {
    signedSums = signedSums.flatMap((sum) => [sum + difference, sum - difference]);
  }
  const observed = Math.abs(differences.reduce((sum, difference) => sum + difference, 0));
  const threshold = observed - observed * TIE_TOLERANCE;
  const extreme = signedSums.filter((sum) => Math.abs(sum) >= threshold).length;
  return extreme / signedSums.length;
}

/**
 * Summarize one round of paired medians.
 *
 * The p-value is the two-sided sign-flip permutation test on `repset[i] - plain[i]`, enumerated
 * exactly over all 2^n sign assignments, so the cost doubles with every pair.
 *
 * @param plain - Per-process medians from the hand-written plain loop.
 * @param repset - Per-process medians from repset, paired index by index with `plain`.
 * @returns The median of each side, the gap `(repset - plain) / plain` between those medians, and
 * the fraction of sign assignments whose absolute signed sum reaches the observed one.
 * @throws RangeError when `plain` is empty or the two arrays differ in length.
 */
export function summarizeCell(plain: readonly number[], repset: readonly number[]): CellSummary {
  if (plain.length !== repset.length) {
    throw new RangeError(
      `expected paired values, got ${plain.length} plain and ${repset.length} repset`,
    );
  }
  const plainMedian = median(plain);
  const repsetMedian = median(repset);
  const differences = repset.map((repsetValue, index) => repsetValue - at(plain, index));
  return {
    plainMedian,
    repsetMedian,
    gap: (repsetMedian - plainMedian) / plainMedian,
    pValue: signFlipPValue(differences),
  };
}

/**
 * Judge one cell, confirming a significant first round with a fresh one.
 *
 * A first round at p >= 0.05 passes outright and `freshRound` is never called. Otherwise the cell
 * fails only when the fresh round alone reads p < 0.05 with a gap of the same sign.
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
  const firstSummary = summarizeCell(first.plain, first.repset);
  if (firstSummary.pValue >= SIGNIFICANCE) {
    return { passed: true, first: firstSummary };
  }
  const fresh = await freshRound();
  const confirmation = summarizeCell(fresh.plain, fresh.repset);
  const confirmed =
    confirmation.pValue < SIGNIFICANCE &&
    Math.sign(confirmation.gap) === Math.sign(firstSummary.gap);
  return { passed: !confirmed, first: firstSummary, confirmation };
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
