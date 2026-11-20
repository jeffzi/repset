import { describe, expect, it } from "vitest";

import {
  describe as describeValue,
  errorStack,
  isRecord,
  property,
  thrownMessage,
  timerResolutionMs,
  valueAt,
} from "../src/utils.js";

const RESOLUTION = 0.125;

/** An `Error` whose `stack` getter throws. */
function unreadableStackError(): Error {
  return Object.defineProperty(new Error("fig"), "stack", {
    get: () => {
      throw new Error("trap");
    },
  });
}

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
  it.each([
    { value: null, text: "null" },
    { value: [1], text: "an array" },
    { value: 5n, text: "5n" },
  ])("names the value as $text", ({ value, text }) => {
    const described = describeValue(value);

    expect(described).toBe(text);
  });

  describe("when given a function", () => {
    it("does not print its source", () => {
      const value = (): number => 1;

      const described = describeValue(value);

      expect(described).not.toContain(String(value));
    });
  });
});

describe("property", () => {
  it.each([
    { what: "an object", value: { version: "1.2.3" }, expected: "1.2.3" },
    { what: "null", value: null, expected: undefined },
    { what: "a string", value: "1.2.3", expected: undefined },
  ])("reads the key of $what as $expected", ({ value, expected }) => {
    const read = property(value, "version");

    expect(read).toBe(expected);
  });
});

describe("isRecord", () => {
  it.each([
    { value: null, why: "null", expected: false },
    { value: [1], why: "an array", expected: false },
    { value: { apple: 1 }, why: "a plain object", expected: true },
  ])("answers $expected for $why", ({ value, expected }) => {
    const answer = isRecord(value);

    expect(answer).toBe(expected);
  });
});

describe("thrownMessage", () => {
  describe("when reading or converting the value throws", () => {
    it.each([
      { thrown: "a value with no string form", value: Object.create(null) as unknown },
      {
        thrown: "an Error whose message getter throws",
        value: Object.defineProperty(new Error("plum"), "message", {
          get: () => {
            throw new Error("kiwi");
          },
        }) as unknown,
      },
      {
        thrown: "an Error whose message has no string form",
        value: Object.defineProperty(new Error("cherry"), "message", {
          value: Object.create(null) as unknown,
        }) as unknown,
      },
    ])("returns a string instead of throwing for $thrown", ({ value }) => {
      const message = (): string => thrownMessage(value);

      expect(message).not.toThrow();
    });
  });

  describe("when the value is an Error whose message is not a string", () => {
    it("returns the string form of the message", () => {
      const error = Object.defineProperty(new Error("cherry"), "message", { value: 42 });

      const read = thrownMessage(error);

      expect(read).toBe("42");
    });
  });
});

describe("errorStack", () => {
  describe("when the value is an Error with a string stack", () => {
    it("returns that stack", () => {
      const error = Object.defineProperty(new Error("plum"), "stack", { value: "at plum" });

      const stack = errorStack(error);

      expect(stack).toBe("at plum");
    });
  });

  describe("when the value holds no readable string stack", () => {
    it.each([
      {
        thrown: "a value that is not an Error, even with a string stack",
        value: { stack: "at pear" },
      },
      {
        thrown: "an Error whose stack is not a string",
        value: Object.defineProperty(new Error("plum"), "stack", { value: 42 }),
      },
      { thrown: "an Error whose stack getter throws", value: unreadableStackError() },
    ])("returns null for $thrown", ({ value }) => {
      const stack = errorStack(value);

      expect(stack).toBeNull();
    });
  });
});

describe("valueAt", () => {
  describe("when the index holds a value", () => {
    it("returns that value", () => {
      const value = valueAt([10, 20], 1);

      expect(value).toBe(20);
    });
  });

  describe("when the index is past the values", () => {
    it("throws a RangeError", () => {
      const read = (): number => valueAt([10, 20], 2);

      expect(read).toThrow(RangeError);
    });
  });
});
