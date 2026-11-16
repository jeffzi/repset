import type { Pairs } from "../../scripts/overhead-check/verdict.js";

/** How many pairs a round takes. */
export const PAIRS = 12;
/** Two-sided sign-test p-value when all twelve pairs differ in the same direction. */
export const SAME_SIGN_P_VALUE = 2 / 4096;
/** The per-call resolution of a pair taken at a 41 ns timer resolution and one call per sample. */
export const ONE_CALL_RESOLUTION = 41;
/** Every pair of a round at {@link ONE_CALL_RESOLUTION}. */
export const ONE_CALL_RESOLUTIONS = Array.from({ length: PAIRS }, () => ONE_CALL_RESOLUTION);

/**
 * Builds twelve per-process medians on each side, every baseline one and every repset one set to
 * one value each.
 */
export function constantMedians(
  baseline: number,
  repset: number,
): Omit<Pairs, "perCallResolutions"> {
  return {
    baseline: Array.from({ length: PAIRS }, () => baseline),
    repset: Array.from({ length: PAIRS }, () => repset),
  };
}

/**
 * Builds a round of twelve pairs at the one-call per-call resolution with constant medians on each
 * side.
 */
export function constantRound(baseline: number, repset: number): Pairs {
  return { ...constantMedians(baseline, repset), perCallResolutions: ONE_CALL_RESOLUTIONS };
}
