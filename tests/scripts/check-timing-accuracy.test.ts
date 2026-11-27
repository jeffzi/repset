import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { baselineMedian, baselineSpawn, runCheck } from "../../scripts/check-timing-accuracy.js";
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

describe("judgeScenario", () => {
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

describe("runCheck", () => {
  describe("when every scenario passes", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });
  });

  describe("when a calibrated reading's timing lasted under its minTime", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, timingMs: READING.minTime - 1 }),
        baseline: () => 1000,
      };

      const status = runCheck(readers, () => undefined);

      expect(status).toBe(1);
    });
  });

  describe("when repset reads higher than the baseline in every pair", () => {
    it("returns 1", () => {
      const readers: Readers = {
        repset: () => ({ ...READING, median: 1100 }),
        baseline: () => 1000,
      };

      const status = runCheck(readers, () => undefined);

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
      const printed: string[] = [];
      const pairLines = (name: string, round: string, repset: number): unknown[] =>
        Array.from({ length: 12 }, (_, index) =>
          expect.stringMatching(
            wordsInOrder(name, round, index + 1, "baseline", baseline, "repset", repset),
          ),
        );

      runCheck(readers, (text) => {
        printed.push(text);
      });

      expect(printed.map((text) => text.split("\n").slice(0, 26))).toStrictEqual(
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
