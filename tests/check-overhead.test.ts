import { describe, expect, it } from "vitest";

import { runCheck } from "../scripts/check-overhead.js";
import type { Scenario, Readers, RepsetReading } from "../scripts/check-overhead.js";

/** The name the check prints for `scenario`. */
function nameOf(scenario: Scenario): string {
  return `${scenario.runtime} ${scenario.countMode} ${scenario.body}`;
}

/** A repset reading above the timing floors, with `overrides` replacing the defaults. */
function createReading(overrides: Partial<RepsetReading> = {}): RepsetReading {
  return {
    median: 1000,
    callsPerSample: 10,
    sampleCount: 64,
    timerResolutionNs: 40,
    timingMs: 1010,
    minTime: 1000,
    ...overrides,
  };
}

/**
 * Readers for every scenario: baseline medians of 1000, and repset readings above the timing floors.
 *
 * @param repsetFor - Replaces fields of a repset reading, given the scenario's name and the 1-based
 *   count of that scenario's repset readings so far.
 * @returns The readers for every scenario.
 */
function createReaders(
  repsetFor: (name: string, call: number) => Partial<RepsetReading> = () => ({}),
): Readers {
  const calls = new Map<string, number>();
  return {
    repset: async (scenario) => {
      const name = nameOf(scenario);
      const call = (calls.get(name) ?? 0) + 1;
      calls.set(name, call);
      return createReading(repsetFor(name, call));
    },
    baseline: async () => 1000,
  };
}

describe("runCheck", () => {
  it("exits 0 when every scenario passes", async () => {
    const status = await runCheck(createReaders(), () => undefined);

    expect(status).toBe(0);
  });
});
