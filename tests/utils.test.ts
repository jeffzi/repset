import { describe, expect, it } from "vitest";

import {
  describe as describeValue,
  slashed,
  thrownMessage,
  timerResolutionMs,
} from "../src/utils.js";

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
});

describe("the describe function", () => {
  describe("when given a function", () => {
    it("names it without printing its source", () => {
      const described = describeValue(() => 1);

      expect(described).toBe("a function");
    });
  });
});

describe("slashed", () => {
  it("replaces every Windows separator with a slash", () => {
    expect(slashed(String.raw`benchmarks\nested\sort.bench.ts`, "\\")).toBe(
      "benchmarks/nested/sort.bench.ts",
    );
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
});
