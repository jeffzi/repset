import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-memory-timing.js";
import type { Readers } from "../../scripts/check-memory-timing.js";
import type { RepsetReading } from "../../scripts/check-timing-accuracy.js";

/** A repset reading whose timing lasted its `minTime`. */
const READING: RepsetReading = {
  median: 1000,
  callsPerSample: 10,
  sampleCount: 64,
  timerResolutionNs: 40,
  timingMs: 1010,
  minTime: 1000,
};

/** Readers for every body: the same reading with memory measured as without. */
const READERS: Readers = {
  alone: () => READING,
  withMemory: () => READING,
};

describe("runCheck", () => {
  describe("when no body's timing differs with memory measured", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });
  });
});
