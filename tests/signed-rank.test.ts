import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "../src/judge.js";
import { isRecord } from "../src/utils.js";
import { fixturePath } from "./helpers/fixture-path.js";

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

/** Whether `value` is a number. */
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Whether `value` is an array of numbers. */
function isNumbers(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isNumber);
}

/** Whether `value` is an object whose every listed field passes its check. */
function hasFields(value: unknown, checks: Record<string, (field: unknown) => boolean>): boolean {
  return isRecord(value) && Object.entries(checks).every(([key, check]) => check(value[key]));
}

/** Whether `value` is a fixture interval: its level and both ends. */
function isInterval(value: unknown): value is FixtureInterval {
  return hasFields(value, { level: isNumber, low: isNumber, high: isNumber });
}

/** Whether `value` is a fixture case, its every field of the right type. */
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
  const cases = isRecord(parsed) ? parsed["cases"] : undefined;
  if (!Array.isArray(cases) || !cases.every(isCase)) {
    throw new Error("tests/fixtures/signed-rank.json holds no signed-rank cases");
  }
  return cases;
}

const CASES = fixtureCases();

/** Decimal digits to which the scipy fixture values must match. */
const FIXTURE_DIGITS = 12;

/** Decimal digits to which Holm-adjusted p-values must match. */
const HOLM_DIGITS = 15;

/** Every fixture interval, flattened with its case's name and differences. */
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
  it("gives 1 when no difference is nonzero", () => {
    const p = signedRankP([0, 0]);

    expect(p).toBe(1);
  });

  it("caps p at 1 when both tails of a central rank sum exceed half", () => {
    const p = signedRankP([1, 2, -3]);

    expect(p).toBe(1);
  });

  it.each(CASES.filter(({ name }) => name !== "untied, n = 6" && name !== "zeros, n = 12"))(
    "agrees with scipy on $name",
    ({ differences, p: expected }) => {
      const p = signedRankP(differences);

      expectRelativelyClose(p, expected);
    },
  );
});

describe("hodgesLehmann", () => {
  it.each(CASES.filter(({ name }) => name === "untied, n = 6" || name === "zeros, n = 12"))(
    "agrees with the fixture on $name",
    ({ differences, estimate: expected }) => {
      const estimate = hodgesLehmann(differences);

      expect(estimate).toBeCloseTo(expected, FIXTURE_DIGITS);
    },
  );
});

describe("signedRankInterval", () => {
  it("throws a RangeError when no order statistic reaches the level", () => {
    const interval = (): readonly [number, number] => signedRankInterval([1, 2, 3], 0.95);

    expect(interval).toThrow(RangeError);
  });

  it.each(INTERVALS.filter(({ name }) => name !== "ties, n = 10" && name !== "untied, n = 54"))(
    "agrees with the fixture on $name at level $level",
    ({ differences, level, low, high }) => {
      const interval = signedRankInterval(differences, level);

      expect(interval).toStrictEqual([
        expect.closeTo(low, FIXTURE_DIGITS),
        expect.closeTo(high, FIXTURE_DIGITS),
      ]);
    },
  );
});

describe("holm", () => {
  it("returns the Holm-adjusted p values in input order", () => {
    const adjusted = holm([0.04, 0.01, 0.03]);

    expect(adjusted).toStrictEqual([
      expect.closeTo(0.06, HOLM_DIGITS),
      expect.closeTo(0.03, HOLM_DIGITS),
      expect.closeTo(0.06, HOLM_DIGITS),
    ]);
  });

  it("caps adjusted values at 1", () => {
    const adjusted = holm([0.7, 0.6]);

    expect(adjusted).toStrictEqual([1, 1]);
  });
});
