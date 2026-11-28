import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import {
  baselineMedian,
  baselineSpawn,
  readArguments,
  runCheck,
} from "../../scripts/check-timing-accuracy.js";
import type { BaselineRun, Readers } from "../../scripts/check-timing-accuracy.js";
import {
  BASELINE_CALLS_VAR,
  BASELINE_SAMPLES_VAR,
  baselineName,
} from "../../scripts/check-timing-accuracy/bodies.js";
import { judgeScenario } from "../../scripts/check-timing-accuracy/verdict.js";
import type { Pairs } from "../../scripts/check-timing-accuracy/verdict.js";
import { errorOf } from "../helpers/error-of.js";
import { failureLine, FN_KIWI } from "../helpers/fake-children.js";
import { READING } from "../helpers/repset-reading.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

/** Readers for every scenario: baseline medians of 1000, and repset readings whose timing lasted their `minTime`. */
const READERS: Readers = {
  repset: () => READING,
  baseline: () => 1000,
};

/** A round whose repset medians sit `differences` (ns) above baselines of 1000. */
function pairsOf(differences: readonly number[]): Pairs {
  return {
    baseline: differences.map(() => 1000),
    repset: differences.map((difference) => 1000 + difference),
    perCallResolutions: differences.map(() => 4),
  };
}

const REPSET_HIGHER = pairsOf(Array.from({ length: 12 }, () => 100));

/** A confirmation round callback that fails the test when the scenario takes it. */
function noConfirmation(): Pairs {
  throw new Error("the confirmation round was taken");
}

describe("judgeScenario", () => {
  it("passes a first round that is not significant without a confirmation round", () => {
    const notSignificant = pairsOf([100, 100, 100, 100, 100, 100, 100, -90, -90, -90, -90, -90]);

    const verdict = judgeScenario(notSignificant, noConfirmation);

    expect(verdict.passed).toBe(true);
  });

  it("reports the first round's gap as the medians' difference over the baseline median", () => {
    // Repset medians 1050 against 1000, while the mean paired difference is about 196 ns.
    const skewed = pairsOf([50, 50, 50, 50, 50, 50, 50, 400, 400, 400, 400, 400]);

    const verdict = judgeScenario(skewed, () => skewed);

    expect(verdict.first.gap).toBeCloseTo(0.05, 10);
  });

  it("reports the first round's exact sign-flip p over the paired differences", () => {
    // Four of the 4096 sign flips reach the observed |sum| of 1050; a sign test would give 26/4096.
    const mostlyHigher = pairsOf([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, -50]);

    const verdict = judgeScenario(mostlyHigher, () => mostlyHigher);

    expect(verdict.first.pValue).toBe(4 / 4096);
  });

  describe("when every pair differs by a millionth of its per-call resolution or less", () => {
    it.each([
      { position: "within the limit", difference: 2e-6 },
      { position: "exactly at the limit", difference: 4e-6 },
    ])("passes with p 1, $position", ({ difference }) => {
      const nearTies: Pairs = {
        baseline: Array.from({ length: 12 }, () => 0),
        repset: Array.from({ length: 12 }, () => difference),
        perCallResolutions: Array.from({ length: 12 }, () => 4),
      };

      const verdict = judgeScenario(nearTies, noConfirmation);

      expect(verdict).toMatchObject({ passed: true, first: { pValue: 1 } });
    });
  });

  describe("when every pair differs by just over a millionth of its per-call resolution", () => {
    it("fails a confirmed round", () => {
      const justOver: Pairs = {
        baseline: Array.from({ length: 12 }, () => 0),
        repset: Array.from({ length: 12 }, () => 8e-6),
        perCallResolutions: Array.from({ length: 12 }, () => 4),
      };

      const verdict = judgeScenario(justOver, () => justOver);

      expect(verdict.passed).toBe(false);
    });
  });

  it.each([
    { arrays: "a shorter repset", repset: 11, resolutions: 12 },
    { arrays: "more per-call resolutions", repset: 12, resolutions: 13 },
  ])("throws a RangeError naming each length for $arrays", ({ repset, resolutions }) => {
    const unpaired: Pairs = {
      baseline: Array.from({ length: 12 }, () => 1000),
      repset: Array.from({ length: repset }, () => 1100),
      perCallResolutions: Array.from({ length: resolutions }, () => 4),
    };

    const error = errorOf(() => judgeScenario(unpaired, noConfirmation));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(wordsInOrder(12, repset, resolutions));
  });

  describe("when a significant first round is not confirmed", () => {
    it.each([
      {
        confirmation: "not significant, same direction",
        differences: [100, 100, 100, 100, 100, 100, 100, -90, -90, -90, -90, -90],
      },
      {
        confirmation: "significant, opposite direction",
        differences: Array.from({ length: 12 }, () => -100),
      },
    ])("passes with a confirmation round $confirmation", ({ differences }) => {
      const verdict = judgeScenario(REPSET_HIGHER, () => pairsOf(differences));

      expect(verdict.passed).toBe(true);
    });
  });

  describe("when given a margin", () => {
    /** A margin of 10%: a mean difference of 100 ns against the baselines of 1000. */
    const MARGIN = 0.1;

    /** A significant round whose twelve pairs all differ by `difference` (ns). */
    function steadyRound(difference: number): Pairs {
      return pairsOf(Array.from({ length: 12 }, () => difference));
    }

    it.each([
      { position: "inside it with repset higher", difference: 80 },
      { position: "exactly at it with repset higher", difference: 100 },
      { position: "inside it with repset lower", difference: -80 },
      { position: "exactly at it with repset lower", difference: -100 },
    ])(
      "passes without a confirmation round when the first round's mean sits $position",
      ({ difference }) => {
        const verdict = judgeScenario(steadyRound(difference), noConfirmation, MARGIN);

        expect(verdict.passed).toBe(true);
      },
    );

    it.each([
      { position: "inside it with repset higher", first: 150, confirmation: 80 },
      { position: "exactly at it with repset higher", first: 150, confirmation: 100 },
      { position: "inside it with repset lower", first: -150, confirmation: -80 },
      { position: "exactly at it with repset lower", first: -150, confirmation: -100 },
    ])(
      "passes when a first round beyond it is confirmed by a round $position",
      ({ first, confirmation }) => {
        const verdict = judgeScenario(steadyRound(first), () => steadyRound(confirmation), MARGIN);

        expect(verdict.passed).toBe(true);
      },
    );

    it.each([
      { direction: "higher", difference: 150 },
      { direction: "lower", difference: -150 },
    ])("fails when both rounds sit beyond it with repset $direction", ({ difference }) => {
      const verdict = judgeScenario(steadyRound(difference), () => steadyRound(difference), MARGIN);

      expect(verdict.passed).toBe(false);
    });

    it("fails when both rounds' mean differences sit beyond it while their medians sit inside it", () => {
      // Repset medians 1050 against 1000 (a 5% gap), but a mean difference of about 196 ns.
      const skewed = pairsOf([50, 50, 50, 50, 50, 50, 50, 400, 400, 400, 400, 400]);

      const verdict = judgeScenario(skewed, () => skewed, MARGIN);

      expect(verdict.passed).toBe(false);
    });
  });
});

/** The name a baseline run's errors start with. */
const SCENARIO_NAME = "node fixed each";

/** A baseline run that ended cleanly: exit 0, an ok result line and a median of 1234.5 ns on stdout. */
const CLEAN_RUN: BaselineRun = {
  status: 0,
  signal: null,
  written: `${JSON.stringify({ status: "ok" })}\n`,
  stdout: `${JSON.stringify({ median: 1234.5 })}\n`,
  stderr: "",
};

describe("baselineMedian", () => {
  describe("when the run ended cleanly", () => {
    it("returns the median it printed", () => {
      const median = baselineMedian(SCENARIO_NAME, CLEAN_RUN);

      expect(median).toBe(1234.5);
    });
  });

  describe("when the run did not end cleanly", () => {
    it.each([
      {
        ending: "a non-zero exit",
        run: { ...CLEAN_RUN, status: 1, written: "", stderr: "banana exploded" },
        inserted: "banana exploded",
      },
      {
        ending: "a failed result line",
        run: { ...CLEAN_RUN, written: failureLine({ ...FN_KIWI, teardownError: null }) },
        inserted: FN_KIWI.message,
      },
      {
        ending: "an exit 0 with no result line",
        run: { ...CLEAN_RUN, written: "" },
        inserted: SCENARIO_NAME,
      },
      {
        ending: "stdout holding no median",
        run: { ...CLEAN_RUN, stdout: `${JSON.stringify({ mean: 1234.5 })}\n` },
        inserted: SCENARIO_NAME,
      },
    ])("throws naming the scenario on $ending", ({ run, inserted }) => {
      const error = errorOf(() => baselineMedian(SCENARIO_NAME, run));

      expect(error.message.slice(0, SCENARIO_NAME.length)).toBe(SCENARIO_NAME);
      expect(error.message).toContain(inserted);
    });
  });
});

describe("baselineSpawn", () => {
  it("asks for the body's baseline case with each count in its own variable", () => {
    const { request, env } = baselineSpawn("inlined", { callsPerSample: 7, sampleCount: 64 });

    expect(request.id).toBe(baselineName("inlined"));
    expect(isAbsolute(request.file)).toBe(true);
    expect(env[BASELINE_CALLS_VAR]).toBe("7");
    expect(env[BASELINE_SAMPLES_VAR]).toBe("64");
  });
});

/** Runs the check under the rule `args` select, returning its status and everything it printed. */
function checkWith(
  readers: Readers,
  args: readonly string[],
): { status: 0 | 1; printed: string[] } {
  const printed: string[] = [];
  const status = runCheck(
    readers,
    (text) => {
      printed.push(text);
    },
    readArguments(args),
  );
  return { status, printed };
}

describe("runCheck", () => {
  describe("when every scenario passes", () => {
    it("returns 0", () => {
      const { status } = checkWith(READERS, []);

      expect(status).toBe(0);
    });
  });

  describe("when a calibrated reading's timing lasted under its minTime", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, timingMs: READING.minTime - 1 }),
        baseline: () => 1000,
      };

      const { status } = checkWith(readers, []);

      expect(status).toBe(1);
    });
  });

  describe("when repset reads higher than the baseline in every pair", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, median: 1100 }),
        baseline: () => 1000,
      };

      const { status } = checkWith(readers, []);

      expect(status).toBe(1);
    });

    it("prints each round's summary then one line per pair naming the scenario, round, pair and both medians", () => {
      const baseline = 1000.987_654_321;
      const firstRepset = 1100.123_456_789;
      const confirmationRepset = 1200.456_789_123;
      const names: string[] = [];
      let calls = 0;
      const readers: Readers = {
        repset: (scenario) => {
          const name = `${scenario.runtime} ${scenario.countMode} ${scenario.body}`;
          if (!names.includes(name)) names.push(name);
          const median = calls++ % 24 < 12 ? firstRepset : confirmationRepset;
          return { ...READING, median };
        },
        baseline: () => baseline,
      };
      const pairLines = (name: string, round: string, repset: number): unknown[] =>
        Array.from({ length: 12 }, (_, index) =>
          expect.stringMatching(
            wordsInOrder(name, round, index + 1, "baseline", baseline, "repset", repset),
          ),
        );

      const { printed } = checkWith(readers, []);

      expect(printed.slice(1).map((text) => text.split("\n").slice(0, 26))).toStrictEqual(
        names.map((name) =>
          [expect.any(String)].concat(
            pairLines(name, "first", firstRepset),
            [expect.any(String)],
            pairLines(name, "confirmation", confirmationRepset),
          ),
        ),
      );
    });
  });
});

describe("readArguments", () => {
  it("throws naming an unknown argument", () => {
    const error = errorOf(() => readArguments(["--banana"]));

    expect(error.message).toContain("--banana");
  });
});

/** Readers whose repset medians sit `gaps` (ns) above baselines of 1000, per runtime. */
function readersWithGaps(gaps: { node: number; bun: number }): Readers {
  return {
    repset: (scenario) => ({ ...READING, median: 1000 + gaps[scenario.runtime] }),
    baseline: () => 1000,
  };
}

describe("runCheck with the rule the arguments select", () => {
  it.each([
    { rule: "strict", args: [], gaps: { node: 0, bun: 30 }, expected: 1 },
    { rule: "CI", args: ["--ci"], gaps: { node: 0, bun: 30 }, expected: 0 },
    { rule: "CI", args: ["--ci"], gaps: { node: 0, bun: 50 }, expected: 1 },
    { rule: "CI", args: ["--ci"], gaps: { node: 30, bun: 0 }, expected: 1 },
  ])(
    "under the $rule rule returns $expected when repset reads node +$gaps.node ns and bun +$gaps.bun ns above 1000",
    ({ args, gaps, expected }) => {
      const { status } = checkWith(readersWithGaps(gaps), args);

      expect(status).toBe(expected);
    },
  );

  it("names the strict rule before the scenarios", () => {
    const { printed } = checkWith(READERS, []);

    expect(printed[0]).toMatch(/\bstrict\b/u);
  });

  it("names the CI rule with the Bun margin before the scenarios", () => {
    const { printed } = checkWith(READERS, ["--ci"]);

    expect(printed[0]).toContain("4%");
  });
});

describe("runCheck summary lines", () => {
  it.each([
    { direction: "higher", near: 1050, far: 1400, relative: "(+19.58%)" },
    { direction: "lower", near: 950, far: 600, relative: "(-19.58%)" },
  ])(
    "show each round's mean paired difference relative to its baseline median as a signed percent with repset $direction",
    ({ near, far, relative }) => {
      // Seven pairs 50 ns apart and five 400 ns apart: a 5% median gap, a mean difference of about 196 ns.
      let calls = 0;
      const readers: Readers = {
        repset: () => ({ ...READING, median: calls++ % 12 < 7 ? near : far }),
        baseline: () => 1000,
      };

      const { printed } = checkWith(readers, []);

      const summaries = printed.slice(1).map((text) => {
        // Line 0 is the first round's summary; 12 pair lines follow it, so line 13 is the confirmation's.
        const lines = text.split("\n");
        return [lines[0], lines[13]];
      });
      expect(summaries).toStrictEqual(
        summaries.map(() => [expect.stringContaining(relative), expect.stringContaining(relative)]),
      );
    },
  );
});
