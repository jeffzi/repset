import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-timing-accuracy.js";
import type { Readers } from "../../scripts/check-timing-accuracy.js";
import { READING } from "../helpers/repset-reading.js";

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
  });
});
