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
});
