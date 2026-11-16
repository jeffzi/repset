import { describe, expect, it } from "vitest";

import { runCheck } from "../scripts/check-overhead.js";
import type { Readers, RepsetReading } from "../scripts/check-overhead.js";

/** A repset reading above the timing floors. */
const READING: RepsetReading = {
  median: 1000,
  callsPerSample: 10,
  sampleCount: 64,
  timerResolutionNs: 40,
  timingMs: 1010,
  minTime: 1000,
};

/** Readers for every scenario: baseline medians of 1000, and repset readings above the floors. */
const READERS: Readers = {
  repset: async () => READING,
  baseline: async () => 1000,
};

describe("runCheck", () => {
  it("exits 0 when every scenario passes", async () => {
    const status = await runCheck(READERS, () => undefined);

    expect(status).toBe(0);
  });
});
