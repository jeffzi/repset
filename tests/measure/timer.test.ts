import { describe, expect, it } from "vitest";

import { timerStepMs } from "../../src/measure/timer.js";

const STEP = 0.125;
const COARSE_TRANSITIONS = 2000;

/**
 * Builds a clock that advances by `stepsAt(transition)` steps per transition, repeating each value a few times.
 */
function scriptedClock(stepsAt: (transition: number) => number, step: number): () => number {
  let value = 1000;
  let transition = 0;
  let repeatsLeft = 1;
  return () => {
    if (repeatsLeft === 0) {
      value += stepsAt(transition) * step;
      transition += 1;
      repeatsLeft = (transition % 3) + 1;
    }
    repeatsLeft -= 1;
    return value;
  };
}

describe("timerStepMs", () => {
  describe("when the first transitions span several steps and later ones span one", () => {
    it("returns the single step", () => {
      const now = scriptedClock(
        (transition) => (transition < COARSE_TRANSITIONS ? 2 + (transition % 2) : 1),
        STEP,
      );

      const step = timerStepMs(now);

      expect(step).toBe(STEP);
    });
  });

  describe("when given no clock", () => {
    it("probes performance.now", () => {
      const step = timerStepMs();

      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(Number.POSITIVE_INFINITY);
    });
  });
});
