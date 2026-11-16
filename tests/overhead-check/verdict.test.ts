import { describe, expect, it } from "vitest";

import { exitStatus, judgeScenario, summarizeRound } from "../../scripts/overhead-check/verdict.js";
import type { Pairs, RoundSummary, ScenarioVerdict } from "../../scripts/overhead-check/verdict.js";
import {
  constantRound,
  ONE_CALL_RESOLUTION,
  ONE_CALL_RESOLUTIONS,
  PAIRS,
  SAME_SIGN_P_VALUE,
} from "./rounds.js";

const SLOWER_REPSET = constantRound(100, 110);
const FASTER_REPSET = constantRound(100, 90);
const NOISE: Pairs = {
  baseline: Array.from({ length: PAIRS }, () => 100),
  repset: Array.from({ length: PAIRS }, (_, index) => (index % 2 === 0 ? 101 : 99)),
  perCallResolutions: ONE_CALL_RESOLUTIONS,
};
/**
 * Twelve pairs whose medians differ only by float rounding: the two doubles one timed span of 22
 * timer resolutions read as on Bun.
 */
const ROUNDING_ONLY = constantRound(916.9999999585343, 917.0000000153777);

const SLOWER_SUMMARY: RoundSummary = {
  baselineMedian: 100,
  repsetMedian: 110,
  gap: 0.1,
  pValue: SAME_SIGN_P_VALUE,
  meanDifference: 10,
};
const FASTER_SUMMARY: RoundSummary = {
  baselineMedian: 100,
  repsetMedian: 90,
  gap: -0.1,
  pValue: SAME_SIGN_P_VALUE,
  meanDifference: -10,
};
const NOISE_SUMMARY: RoundSummary = {
  baselineMedian: 100,
  repsetMedian: 100,
  gap: 0,
  pValue: 1,
  meanDifference: 0,
};

const TIED_MEDIAN = 917;
const TIED_BASELINE = [800, 800, 800, 917, 917, 917, 917, 917, 1000, 1000, 1000, 1000];

/** Builds a round whose seven outer pairs differ by `shift` while both sides' medians stay 917. */
function tiedMedianRound(shift: number): Pairs {
  return {
    baseline: TIED_BASELINE,
    repset: TIED_BASELINE.map((value) => (value === TIED_MEDIAN ? value : value + shift)),
    perCallResolutions: ONE_CALL_RESOLUTIONS,
  };
}

/** Seven pairs differing by `shift` and five tied: 2 * 2^5 of the 2^12 sign assignments. */
function tiedMedianSummary(shift: number): RoundSummary {
  return {
    baselineMedian: TIED_MEDIAN,
    repsetMedian: TIED_MEDIAN,
    gap: 0,
    pValue: 64 / 4096,
    meanDifference: (7 * shift) / PAIRS,
  };
}

/**
 * Six pairs 1 ns apart one way and six 30 ns apart the other, at the one-call per-call resolution.
 */
function splitRound(sign: 1 | -1): Pairs {
  return {
    ...constantRound(100, 100),
    repset: Array.from({ length: PAIRS }, (_, index) => 100 + sign * (index < 6 ? -1 : 30)),
  };
}

/** Confirmation-round source that fails the test when the verdict asks for a confirmation round. */
function noConfirmationRound(): Pairs {
  throw new Error("confirmation round requested");
}

/** Builds a verdict with a fixed first-round summary. */
function createVerdict(passed: boolean): ScenarioVerdict {
  return { passed, first: NOISE_SUMMARY };
}

describe("summarizeRound", () => {
  describe("when the pair count is odd", () => {
    it("reports the middle value as each median", () => {
      const summary = summarizeRound([3, 1, 2], [6, 4, 5], [41, 41, 41]);

      expect([summary.baselineMedian, summary.repsetMedian]).toStrictEqual([2, 5]);
    });
  });

  describe("when the pair count is even", () => {
    it("reports the mean of the two middle values as each median", () => {
      const summary = summarizeRound([4, 1, 3, 2], [8, 2, 6, 4], [41, 41, 41, 41]);

      expect([summary.baselineMedian, summary.repsetMedian]).toStrictEqual([2.5, 5]);
    });
  });

  describe("gap", () => {
    it("is the repset median's difference from the baseline median, relative to the baseline median", () => {
      const summary = summarizeRound([2], [5], [41]);

      expect(summary.gap).toBe(1.5);
    });
  });

  describe("p-value", () => {
    it.each([
      { label: "all differences zero", baseline: [5, 5, 5], repset: [5, 5, 5], expected: 1 },
      { label: "differences [1, -1]", baseline: [10, 10], repset: [11, 9], expected: 1 },
      // Paired by sorted rank these would read differences [1, 1] and p = 2/4.
      { label: "pairs taken by index", baseline: [1, 10], repset: [11, 2], expected: 1 },
      {
        label: "ties that differ only by float rounding",
        baseline: [1, 1, 1],
        repset: [1.1, 1.2, 0.9],
        expected: 6 / 8,
      },
      {
        // The two doubles one timed span of 22 timer resolutions read as on Bun, 5.7e-8 ns apart.
        label: "pairs whose medians differ only by float rounding",
        baseline: [916.9999999585343, 916.9999999585343, 916.9999999585343],
        repset: [917.0000000153777, 917.0000000153777, 917.0000000153777],
        expected: 1,
      },
      // At 8 calls per sample the per-call resolution is 41/8 ns, so a pair ties within
      // 5.125e-6 ns.
      {
        label: "pairs 1/8 ns apart at 8 calls",
        baseline: [1000, 1000, 1000],
        repset: [1000.125, 1000.125, 1000.125],
        perCallResolution: 41 / 8,
        expected: 0.25,
      },
      {
        label: "pairs just under a millionth of their per-call resolution apart",
        baseline: [1, 1, 1],
        repset: [1.0000051, 1.0000051, 1.0000051],
        perCallResolution: 41 / 8,
        expected: 1,
      },
      {
        label: "pairs just over a millionth of their per-call resolution apart",
        baseline: [1, 1, 1],
        repset: [1.00000515, 1.00000515, 1.00000515],
        perCallResolution: 41 / 8,
        expected: 0.25,
      },
      // 3e-5 ns ties at a 41 ns per-call resolution and counts at a 41/8 ns one.
      {
        label: "each pair judged by its own per-call resolution",
        baseline: [1, 1, 1],
        repset: [1.00003, 1.00003, 1.00003],
        perCallResolutions: [41 / 8, 41 / 8, 41],
        expected: 0.5,
      },
    ])(
      "is $expected for $label",
      ({
        baseline,
        repset,
        perCallResolution = ONE_CALL_RESOLUTION,
        perCallResolutions,
        expected,
      }) => {
        const summary = summarizeRound(
          baseline,
          repset,
          perCallResolutions ?? baseline.map(() => perCallResolution),
        );

        expect(summary.pValue).toBe(expected);
      },
    );
  });

  describe("mean difference", () => {
    it.each([
      {
        label: "seven pairs 41 ns higher and five tied",
        round: tiedMedianRound(41),
        expected: 287 / 12,
      },
      { label: "pairs that differ only by float rounding", round: ROUNDING_ONLY, expected: 0 },
    ])("is $expected ns for $label", ({ round, expected }) => {
      const summary = summarizeRound(round.baseline, round.repset, round.perCallResolutions);

      expect(summary.meanDifference).toBe(expected);
    });
  });
});

describe("judgeScenario", () => {
  describe("when the first round reads p >= 0.05", () => {
    it("passes without taking a confirmation round", async () => {
      const verdict = await judgeScenario(NOISE, noConfirmationRound);

      expect(verdict).toStrictEqual({ passed: true, first: NOISE_SUMMARY });
    });
  });

  describe("when the first round reads p < 0.05", () => {
    it("fails when the confirmation round also reads p < 0.05 with differences of the same sign", async () => {
      const verdict = await judgeScenario(SLOWER_REPSET, () => Promise.resolve(SLOWER_REPSET));

      expect(verdict).toStrictEqual({
        passed: false,
        first: SLOWER_SUMMARY,
        confirmation: SLOWER_SUMMARY,
      });
    });

    it("passes when the confirmation round reads p >= 0.05", async () => {
      const verdict = await judgeScenario(SLOWER_REPSET, () => NOISE);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: NOISE_SUMMARY,
      });
    });

    it("passes when the confirmation round reads p < 0.05 with differences of the opposite sign", async () => {
      const verdict = await judgeScenario(SLOWER_REPSET, () => FASTER_REPSET);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: FASTER_SUMMARY,
      });
    });

    it("fails when the differences keep their sign between rounds whose medians tie", async () => {
      const verdict = await judgeScenario(tiedMedianRound(41), () => tiedMedianRound(41));

      expect(verdict).toStrictEqual({
        passed: false,
        first: tiedMedianSummary(41),
        confirmation: tiedMedianSummary(41),
      });
    });

    it("passes when the differences change sign between rounds whose medians tie", async () => {
      const verdict = await judgeScenario(tiedMedianRound(41), () => tiedMedianRound(-41));

      expect(verdict).toStrictEqual({
        passed: true,
        first: tiedMedianSummary(41),
        confirmation: tiedMedianSummary(-41),
      });
    });

    // Six pairs each way: the summed differences, not the count of pairs, give the direction.
    it.each([
      { label: "the same round", confirmation: splitRound(1), passed: false },
      { label: "its mirror", confirmation: splitRound(-1), passed: true },
    ])(
      "is passed: $passed when a split round is confirmed by $label",
      async ({ confirmation, passed }) => {
        const verdict = await judgeScenario(splitRound(1), () => confirmation);

        expect([verdict.passed, verdict.first.pValue]).toStrictEqual([passed, 0.031_25]);
      },
    );
  });

  describe("when the pairs differ only by float rounding", () => {
    it("passes without taking a confirmation round", async () => {
      const verdict = await judgeScenario(ROUNDING_ONLY, noConfirmationRound);

      expect([verdict.passed, verdict.first.pValue]).toStrictEqual([true, 1]);
    });
  });
});

describe("exitStatus", () => {
  it.each([
    {
      label: "every scenario passed",
      verdicts: [createVerdict(true), createVerdict(true)],
      expected: 0,
    },
    {
      label: "any scenario failed",
      verdicts: [createVerdict(true), createVerdict(false)],
      expected: 1,
    },
  ])("is $expected when $label", ({ verdicts, expected }) => {
    const status = exitStatus(verdicts);

    expect(status).toBe(expected);
  });
});
