import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-timing-accuracy.js";
import type { Readers } from "../../scripts/check-timing-accuracy.js";
import { judgeScenario } from "../../scripts/check-timing-accuracy/verdict.js";
import type { Pairs } from "../../scripts/check-timing-accuracy/verdict.js";
import { READING } from "../helpers/repset-reading.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

/** Readers for every scenario: baseline medians of 1000, and repset readings whose timing lasted their `minTime`. */
const READERS: Readers = {
  repset: () => READING,
  baseline: () => 1000,
};

/** A round whose repset medians sit `differences` (ns) above baselines of 1000. */
function pairsOf(differences: readonly number[]): Pairs {
  return {
    baseline: differences.map(() => 1000),
    repset: differences.map((difference) => 1000 + difference),
    perCallResolutions: differences.map(() => 4),
  };
}

const REPSET_HIGHER = pairsOf(Array.from({ length: 12 }, () => 100));

describe("judgeScenario", () => {
  describe("when a significant first round is not confirmed", () => {
    it.each([
      {
        confirmation: "not significant, same direction",
        differences: [100, 100, 100, 100, 100, 100, 100, -90, -90, -90, -90, -90],
      },
      {
        confirmation: "significant, opposite direction",
        differences: Array.from({ length: 12 }, () => -100),
      },
    ])("passes with a confirmation round $confirmation", ({ differences }) => {
      const verdict = judgeScenario(REPSET_HIGHER, () => pairsOf(differences));

      expect(verdict.passed).toBe(true);
    });
  });
});

describe("runCheck", () => {
  describe("when every scenario passes", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });
  });

  describe("when a calibrated reading's timing lasted under its minTime", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, timingMs: READING.minTime - 1 }),
        baseline: () => 1000,
      };

      const status = runCheck(readers, () => undefined);

      expect(status).toBe(1);
    });
  });

  describe("when repset reads higher than the baseline in every pair", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, median: 1100 }),
        baseline: () => 1000,
      };

      const status = runCheck(readers, () => undefined);

      expect(status).toBe(1);
    });

    it("prints each round's summary then one line per pair naming the scenario, round, pair and both medians", () => {
      const baseline = 1000.987_654_321;
      const firstRepset = 1100.123_456_789;
      const confirmationRepset = 1200.456_789_123;
      const names: string[] = [];
      let calls = 0;
      const readers: Readers = {
        repset: (scenario) => {
          const name = `${scenario.runtime} ${scenario.countMode} ${scenario.body}`;
          if (!names.includes(name)) names.push(name);
          const median = calls++ % 24 < 12 ? firstRepset : confirmationRepset;
          return { ...READING, median };
        },
        baseline: () => baseline,
      };
      const printed: string[] = [];
      const pairLines = (name: string, round: string, repset: number): unknown[] =>
        Array.from({ length: 12 }, (_, index) =>
          expect.stringMatching(
            wordsInOrder(name, round, index + 1, "baseline", baseline, "repset", repset),
          ),
        );

      runCheck(readers, (text) => {
        printed.push(text);
      });

      expect(printed.map((text) => text.split("\n").slice(0, 26))).toStrictEqual(
        names.map((name) =>
          [expect.any(String)].concat(
            pairLines(name, "first", firstRepset),
            [expect.any(String)],
            pairLines(name, "confirmation", confirmationRepset),
          ),
        ),
      );
    });
  });
});
