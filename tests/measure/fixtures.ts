/** A timer step fine enough that 100 ms samples span far more than 200 steps. */
export const FINE_STEP = 2 ** -10;

/** A timer step coarse enough that short samples span few steps or none. */
export const COARSE_STEP = 2 ** -4;

/** Index of the first of the last five of the 16 warmup samples. */
const LAST_FIVE_FROM = 11;

/** One settled-flag scenario: the body cost per warmup sample and the flag it must produce. */
interface SettledCase {
  readonly when: string;
  readonly costMs: (sample: number) => number;
  readonly expected: boolean;
}

/** The settled-flag scenarios both samplers share. */
export const SETTLED_CASES: readonly SettledCase[] = [
  {
    when: "the last five per-call costs lie within 5 % of their median",
    costMs: (sample) =>
      [100, 104, 100, 96, 100][sample - LAST_FIVE_FROM] ??
      (sample === LAST_FIVE_FROM - 1 ? 500 : 100),
    expected: true,
  },
  {
    when: "one of the last five per-call costs lies 6 % from their median",
    costMs: (sample) => [100, 104, 106, 96, 100][sample - LAST_FIVE_FROM] ?? 100,
    expected: false,
  },
  {
    when: "the last five spans differ but their per-call costs agree",
    costMs: (sample) => (sample < LAST_FIVE_FROM ? 50 : 2 ** -6),
    expected: true,
  },
];
