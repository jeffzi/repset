import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repsetReading, runCheck } from "../scripts/check-overhead.js";
import type { Readers, RepsetReading } from "../scripts/check-overhead.js";
import { temporaryDir } from "./temporary-dir.js";

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

describe("repsetReading", () => {
  describe("when the report's measurement holds no time", () => {
    it("throws an error naming the scenario", () => {
      const reportPath = join(temporaryDir("repset-overhead-"), "report.json");
      const report = {
        schema: 1,
        options: { minTime: 1000 },
        results: [{ status: "ok", measurements: [{ time: null, memory: null }] }],
        contests: [],
        interrupted: false,
      };
      writeFileSync(reportPath, JSON.stringify(report));
      const scenario = { runtime: "node", countMode: "calibrated", body: "each" } as const;

      const read = (): unknown => repsetReading(scenario, { status: 0, signal: null }, reportPath);

      expect(read).toThrow("node calibrated each: repset's report holds no time");
    });
  });
});
