import { describe, expect, it } from "vitest";

import { runCheck } from "../scripts/check-overhead.js";
import type { Readers, RepsetReading } from "../scripts/check-overhead.js";

/** A repset reading whose timing lasted its `minTime`. */
const READING: RepsetReading = {
  median: 1000,
  callsPerSample: 10,
  sampleCount: 64,
  timerResolutionNs: 40,
  timingMs: 1010,
  minTime: 1000,
};

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
