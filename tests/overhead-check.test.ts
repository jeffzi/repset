import { describe, expect, it } from "vitest";

import { exitStatus, judgeCell, summarizeCell } from "../scripts/overhead-check/verdict.js";
import type { CellSummary, CellVerdict, Pairs } from "../scripts/overhead-check/verdict.js";

const PAIRS = 12;
/** Two-sided sign-test p-value when all twelve pairs differ in the same direction. */
const SAME_SIGN_P_VALUE = 2 / 4096;

/** Builds a round of twelve pairs with every plain median and every repset median set to one value each. */
function constantRound(plain: number, repset: number): Pairs {
  return {
    plain: Array.from({ length: PAIRS }, () => plain),
    repset: Array.from({ length: PAIRS }, () => repset),
  };
}

const SLOWER_REPSET = constantRound(100, 110);
const FASTER_REPSET = constantRound(100, 90);
const NOISE = {
  plain: Array.from({ length: PAIRS }, () => 100),
  repset: Array.from({ length: PAIRS }, (_, index) => (index % 2 === 0 ? 101 : 99)),
};

const SLOWER_SUMMARY: CellSummary = {
  plainMedian: 100,
  repsetMedian: 110,
  gap: 0.1,
  pValue: SAME_SIGN_P_VALUE,
};
const FASTER_SUMMARY: CellSummary = {
  plainMedian: 100,
  repsetMedian: 90,
  gap: -0.1,
  pValue: SAME_SIGN_P_VALUE,
};
const NOISE_SUMMARY: CellSummary = { plainMedian: 100, repsetMedian: 100, gap: 0, pValue: 1 };

/** Fresh-round source that fails the test when the verdict asks for a confirmation round. */
function noFreshRound(): Pairs {
  throw new Error("fresh round requested");
}

/** Builds a verdict with a fixed first-round summary. */
function createVerdict(passed: boolean): CellVerdict {
  return { passed, first: NOISE_SUMMARY };
}

describe("summarizeCell", () => {
  describe("when the pair count is odd", () => {
    it("reports the middle value as each median", () => {
      const summary = summarizeCell([3, 1, 2], [6, 4, 5]);

      expect([summary.plainMedian, summary.repsetMedian]).toStrictEqual([2, 5]);
    });
  });

  describe("when the pair count is even", () => {
    it("reports the mean of the two middle values as each median", () => {
      const summary = summarizeCell([4, 1, 3, 2], [8, 2, 6, 4]);

      expect([summary.plainMedian, summary.repsetMedian]).toStrictEqual([2.5, 5]);
    });
  });

  describe("gap", () => {
    it("is the repset median's difference from the plain median, relative to the plain median", () => {
      const summary = summarizeCell([2], [5]);

      expect(summary.gap).toBe(1.5);
    });
  });

  describe("p-value", () => {
    it.each([
      { label: "all differences zero", plain: [5, 5, 5], repset: [5, 5, 5], expected: 1 },
      { label: "differences [1, -1]", plain: [10, 10], repset: [11, 9], expected: 1 },
      // Paired by sorted rank these would read differences [1, 1] and p = 2/4.
      { label: "pairs taken by index", plain: [1, 10], repset: [11, 2], expected: 1 },
      {
        label: "ties that differ only by float rounding",
        plain: [1, 1, 1],
        repset: [1.1, 1.2, 0.9],
        expected: 6 / 8,
      },
    ])("is $expected for $label", ({ plain, repset, expected }) => {
      const summary = summarizeCell(plain, repset);

      expect(summary.pValue).toBe(expected);
    });
  });
});

describe("judgeCell", () => {
  describe("when the first round reads p >= 0.05", () => {
    it("passes without taking a fresh round", async () => {
      const verdict = await judgeCell(NOISE, noFreshRound);

      expect(verdict).toStrictEqual({ passed: true, first: NOISE_SUMMARY });
    });
  });

  describe("when the first round reads p < 0.05", () => {
    it("fails when the fresh round also reads p < 0.05 with the same gap sign", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => Promise.resolve(SLOWER_REPSET));

      expect(verdict).toStrictEqual({
        passed: false,
        first: SLOWER_SUMMARY,
        confirmation: SLOWER_SUMMARY,
      });
    });

    it("passes when the fresh round reads p >= 0.05", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => NOISE);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: NOISE_SUMMARY,
      });
    });

    it("passes when the fresh round reads p < 0.05 with the opposite gap sign", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => FASTER_REPSET);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: FASTER_SUMMARY,
      });
    });
  });
});

describe("exitStatus", () => {
  it.each([
    {
      label: "every cell passed",
      verdicts: [createVerdict(true), createVerdict(true)],
      expected: 0,
    },
    {
      label: "any cell failed",
      verdicts: [createVerdict(true), createVerdict(false)],
      expected: 1,
    },
  ])("is $expected when $label", ({ verdicts, expected }) => {
    const status = exitStatus(verdicts);

    expect(status).toBe(expected);
  });
});
