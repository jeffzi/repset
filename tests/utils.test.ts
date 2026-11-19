import { describe, expect, it } from "vitest";

import { describe as describeValue, thrownMessage, timerResolutionMs } from "../src/utils.js";

const RESOLUTION = 0.125;

/**
 * The first transition that spans a single resolution; every one before it spans several.
 *
 * Tied to `TRANSITIONS_PER_PASS` (P) in `src/utils.ts`, together with {@link FINE_TRANSITIONS_END}:
 * both must stay strictly between P and 2P, this one first. The discarded first pass is then
 * entirely coarse, and the measured second pass runs coarse, fine, then coarse again, so a probe
 * that keeps its largest, first or last change instead of the smallest fails. Move both when P
 * changes.
 */
const COARSE_TRANSITIONS = 3000;

/** The first transition after {@link COARSE_TRANSITIONS} that spans several resolutions again. */
const FINE_TRANSITIONS_END = 3500;

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
  describe("when a run of single-resolution transitions falls inside the measured second pass, between coarser ones", () => {
    it("returns the single resolution", () => {
      const now = scriptedClock(
        (transition) =>
          transition >= COARSE_TRANSITIONS && transition < FINE_TRANSITIONS_END
            ? 1
            : 2 + (transition % 2),
        RESOLUTION,
      );

      const resolution = timerResolutionMs(now);

      expect(resolution).toBe(RESOLUTION);
    });
  });
});

describe("the describe function", () => {
  describe("when given a function", () => {
    it("does not print its source", () => {
      const value = (): number => 1;

      const described = describeValue(value);

      expect(described).not.toContain(String(value));
    });
  });
});

describe("thrownMessage", () => {
  describe("when the value has no string form", () => {
    it("returns a string instead of throwing", () => {
      const unprintable: unknown = Object.create(null);

      const message = (): string => thrownMessage(unprintable);

      expect(message).not.toThrow();
    });
  });

  describe("when the value is an Error whose message cannot be read", () => {
    it("returns a string instead of throwing", () => {
      const unreadable = Object.defineProperty(new Error("plum"), "message", {
        get: () => {
          throw new Error("kiwi");
        },
      });

      const message = (): string => thrownMessage(unreadable);

      expect(message).not.toThrow();
    });
  });
});
