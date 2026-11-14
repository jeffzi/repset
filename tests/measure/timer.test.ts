import { describe, expect, it } from "vitest";

import { timerResolutionMs } from "../../src/measure/timer.js";

const RESOLUTION = 0.125;
const COARSE_TRANSITIONS = 2000;

/**
 * Builds a clock that advances by `resolutionsAt(transition)` resolutions per transition, repeating each value a few times.
 */
function scriptedClock(
  resolutionsAt: (transition: number) => number,
  resolution: number,
): () => number {
  let value = 1000;
  let transition = 0;
  let repeatsLeft = 1;
  return () => {
    if (repeatsLeft === 0) {
      value += resolutionsAt(transition) * resolution;
      transition += 1;
      repeatsLeft = (transition % 3) + 1;
    }
    repeatsLeft -= 1;
    return value;
  };
}

describe("timerResolutionMs", () => {
  describe("when the first transitions span several multiples of the resolution and later ones span one", () => {
    it("returns the single resolution", () => {
      const now = scriptedClock(
        (transition) => (transition < COARSE_TRANSITIONS ? 2 + (transition % 2) : 1),
        RESOLUTION,
      );

      const resolution = timerResolutionMs(now);

      expect(resolution).toBe(RESOLUTION);
    });
  });

  describe("when given no clock", () => {
    it("probes performance.now", () => {
      const resolution = timerResolutionMs();

      expect(resolution).toBeGreaterThan(0);
      expect(resolution).toBeLessThan(Number.POSITIVE_INFINITY);
    });
  });
});
