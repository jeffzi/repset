import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "../src/signed-rank.js";
import { isRecord } from "../src/utils.js";
import { fixturePath } from "./fixture-path.js";

interface FixtureInterval {
  readonly level: number;
  readonly low: number;
  readonly high: number;
}

/** One fixture case: its differences beside scipy's p and the Walsh-average estimate and intervals. */
interface FixtureCase {
  readonly name: string;
  readonly differences: readonly number[];
  readonly p: number;
  readonly estimate: number;
  readonly intervals: readonly FixtureInterval[];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isNumbers(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isNumber);
}

/** Whether `value` is an object whose every listed field passes its check. */
function hasFields(value: unknown, checks: Record<string, (field: unknown) => boolean>): boolean {
  return isRecord(value) && Object.entries(checks).every(([key, check]) => check(value[key]));
}

function isInterval(value: unknown): value is FixtureInterval {
  return hasFields(value, { level: isNumber, low: isNumber, high: isNumber });
}

function isCase(value: unknown): value is FixtureCase {
  return hasFields(value, {
    name: (field) => typeof field === "string",
    differences: isNumbers,
    p: isNumber,
    estimate: isNumber,
    intervals: (field) => Array.isArray(field) && field.every(isInterval),
  });
}

/** The cases of `tests/fixtures/signed-rank.json`. */
function fixtureCases(): readonly FixtureCase[] {
  const parsed: unknown = JSON.parse(readFileSync(fixturePath("signed-rank.json"), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("cases" in parsed) ||
    !Array.isArray(parsed.cases) ||
    !parsed.cases.every(isCase)
  ) {
    throw new Error("tests/fixtures/signed-rank.json holds no signed-rank cases");
  }
  return parsed.cases;
}

const CASES = fixtureCases();

const INTERVALS = CASES.flatMap((fixture) =>
  fixture.intervals.map((interval) => ({
    ...interval,
    name: fixture.name,
    differences: fixture.differences,
  })),
);

/** Asserts `actual` lies within a relative 1e-10 of `expected`. */
function expectRelativelyClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-10 * Math.abs(expected));
}

describe("signedRankP", () => {
  describe("when every difference has the same sign", () => {
    it.each([
      { differences: [1, 2, 3, 4, 5, 6], expected: 0.031_25 },
      { differences: [-1, -2, -3, -4, -5, -6], expected: 0.031_25 },
    ])("gives 2 / 2^n for $differences", ({ differences, expected }) => {
      const p = signedRankP(differences);

      expect(p).toBe(expected);
    });
  });

  describe("when one difference dissents at the smallest rank", () => {
    it("gives 4 / 2^n", () => {
      const p = signedRankP([-1, 2, 3, 4, 5, 6]);

      expect(p).toBe(0.0625);
    });
  });

  it("drops zero differences before ranking", () => {
    const p = signedRankP([0, 1, 2, 3]);

    expect(p).toBe(0.25);
  });

  it("gives 1 when no difference is nonzero", () => {
    const p = signedRankP([0, 0]);

    expect(p).toBe(1);
  });

  it("caps p at 1 when both tails of a central rank sum exceed half", () => {
    const p = signedRankP([1, 2, -3]);

    expect(p).toBe(1);
  });

  it("gives equal magnitudes their average rank", () => {
    const p = signedRankP([-1, 1, 2]);

    expect(p).toBe(0.75);
  });

  it.each(CASES)("agrees with scipy on $name", ({ differences, p: expected }) => {
    const p = signedRankP(differences);

    expectRelativelyClose(p, expected);
  });
});

describe("hodgesLehmann", () => {
  it("is the median of the Walsh averages, zeros included", () => {
    const estimate = hodgesLehmann([0, 1, 5]);

    expect(estimate).toBe(1.75);
  });

  it.each(CASES)("agrees with the fixture on $name", ({ differences, estimate: expected }) => {
    const estimate = hodgesLehmann(differences);

    expect(estimate).toBeCloseTo(expected, 12);
  });
});

describe("signedRankInterval", () => {
  it("takes the Walsh-average order statistics at the critical value, zeros included", () => {
    const interval = signedRankInterval([0, 1, 2, 3, 4, 5], 0.9);

    expect(interval).toStrictEqual([1, 4]);
  });

  it("spans every Walsh average when only the extreme order statistic qualifies", () => {
    const interval = signedRankInterval([1, 2, 3, 4, 5, 6], 0.95);

    expect(interval).toStrictEqual([1, 6]);
  });

  it("throws a RangeError when no order statistic reaches the level", () => {
    const interval = (): readonly [number, number] => signedRankInterval([1, 2, 3], 0.95);

    expect(interval).toThrow(RangeError);
  });

  it.each(INTERVALS)(
    "agrees with the fixture on $name at level $level",
    ({ differences, level, low, high }) => {
      const [actualLow, actualHigh] = signedRankInterval(differences, level);

      expect(actualLow).toBeCloseTo(low, 12);
      expect(actualHigh).toBeCloseTo(high, 12);
    },
  );
});

describe("holm", () => {
  it("returns the Holm-adjusted p values in input order", () => {
    const adjusted = holm([0.04, 0.01, 0.03]);

    expect(adjusted[0]).toBeCloseTo(0.06, 15);
    expect(adjusted[1]).toBeCloseTo(0.03, 15);
    expect(adjusted[2]).toBeCloseTo(0.06, 15);
  });

  it("caps adjusted values at 1", () => {
    const adjusted = holm([0.7, 0.6]);

    expect(adjusted).toStrictEqual([1, 1]);
  });
});
