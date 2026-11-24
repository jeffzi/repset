import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-timing-accuracy.js";
import type { Readers } from "../../scripts/check-timing-accuracy.js";
import { READING } from "../helpers/repset-reading.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

/** Readers for every scenario: baseline medians of 1000, and repset readings whose timing lasted their `minTime`. */
const READERS: Readers = {
  repset: () => READING,
  baseline: () => 1000,
};

describe("runCheck", () => {
  describe("when every scenario passes", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
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
