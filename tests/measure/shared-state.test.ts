import { describe, expect, it } from "vitest";

import {
  CalibrationError,
  sampleSharedState,
  type SamplerResult,
} from "../../src/measure/shared-state.js";
import { COARSE_RESOLUTION, FINE_RESOLUTION } from "./fixtures.js";

interface World {
  readonly name: string;
}

interface Harness {
  readonly now: () => number;
  readonly fn: (state: World) => void;
  readonly collect: () => void;
  readonly afterTiming: () => void;
  readonly sampleCalls: number[];
  readonly sampleSpans: number[];
  readonly collectsAt: number[];
  readonly afterTimingAt: number[];
  readonly events: string[];
  readonly states: Set<World>;
}

/** The body's cost per call: `run` is 0 during warmup and the timing attempt's number after. */
type CostMs = (sample: number, timed: boolean, run: number) => number;

/**
 * Builds a virtual clock that only the body advances, recording the body calls and the span
 * between clock reads.
 */
function harness(costMs: CostMs): Harness {
  let time = 1000;
  let lastRead = time;
  let pending = 0;
  const sampleCalls: number[] = [];
  const sampleSpans: number[] = [];
  const collectsAt: number[] = [];
  const afterTimingAt: number[] = [];
  const events: string[] = [];
  const states = new Set<World>();
  return {
    now: () => {
      if (pending > 0) {
        sampleCalls.push(pending);
        sampleSpans.push(time - lastRead);
        pending = 0;
      }
      lastRead = time;
      return time;
    },
    fn: (state) => {
      states.add(state);
      time += costMs(sampleCalls.length, collectsAt.length > 0, collectsAt.length);
      pending += 1;
    },
    collect: () => {
      collectsAt.push(sampleCalls.length);
      events.push("collect");
    },
    afterTiming: () => {
      afterTimingAt.push(sampleCalls.length);
      events.push("afterTiming");
    },
    sampleCalls,
    sampleSpans,
    collectsAt,
    afterTimingAt,
    events,
    states,
  };
}

interface RunOptions {
  readonly callsPerSample?: number;
  readonly afterTiming?: boolean;
  readonly minTime?: number;
  readonly minSamples?: number;
}

/** Runs the sampler on a harness with a fresh state, for 1000 ms and 64 samples unless given. */
function run(fake: Harness, resolutionMs: number, options: RunOptions = {}): SamplerResult {
  const state: World = { name: "world" };
  return sampleSharedState({
    now: fake.now,
    resolutionMs,
    fn: fake.fn,
    state,
    collect: fake.collect,
    minTime: options.minTime ?? 1000,
    minSamples: options.minSamples ?? 64,
    ...(options.callsPerSample === undefined ? {} : { callsPerSample: options.callsPerSample }),
    ...(options.afterTiming === true ? { afterTiming: fake.afterTiming } : {}),
  });
}

/** Milliseconds spanning `count` multiples of the coarse resolution. */
function coarse(count: number): number {
  return count * COARSE_RESOLUTION;
}

/**
 * Costs 40 times the resolution a call during warmup and from the second timing attempt on, so warmup settles
 * on 5 calls per sample, and `firstRun` a call during the first timing attempt.
 */
function slowerAfterFirstRun(firstRun: (sample: number) => number): CostMs {
  return (sample, _timed, timingRun) => (timingRun === 1 ? firstRun(sample) : coarse(40));
}

/**
 * Costs 21.6 times the resolution a call on every tenth sample and 30 on the rest, so a first run of 5 calls
 * per sample is discarded and its shortest sample grows the count to 10.
 */
function shortestFirstRun(sample: number): number {
  return coarse(sample % 10 === 0 ? 21.6 : 30);
}

/** A timer resolution whose cap, `ceil(200 × resolution / 0.1 ns)`, is 30518 calls. */
const CAPPED_STEP = 2 ** -16;

/**
 * Costs one capped resolution a call for the first warmup sample and 0.25 ms after, so warmup settles on
 * 200 calls; then, per timing attempt, one sample in three spans 50 ms and the others span the run's
 * short multiple of the resolution, so each run's median falls under 200 times the resolution.
 */
function shortRuns(runs: readonly { calls: number; shortSteps: number }[]): CostMs {
  return (sample, _timed, timingRun) => {
    if (timingRun === 0) return sample === 0 ? CAPPED_STEP : 0.25;
    const { calls, shortSteps } = runs[timingRun - 1] ?? { calls: 1, shortSteps: 1000 };
    return sample % 3 === 0 ? 50 / calls : (shortSteps * CAPPED_STEP) / calls;
  };
}

/** Costs 40 times the resolution a call in warmup, then halves per timing attempt so every run spans 100 times the resolution. */
function fasterEveryRun(_sample: number, _timed: boolean, timingRun: number): number {
  return timingRun === 0 ? coarse(40) : coarse(20 / 2 ** (timingRun - 1));
}

/**
 * Costs 100 ms a call outside the first timing attempt, so warmup runs 16 samples of one call; in the
 * first run, 50 ms on every third sample and 10 times the resolution on the rest, so its 64 samples are
 * discarded and the count grows to 20 for a kept second run of 64 samples of 2000 ms.
 */
function discardedFirstRun(sample: number, _timed: boolean, timingRun: number): number {
  if (timingRun !== 1) return 100;
  return sample % 3 === 0 ? 50 : 10 * FINE_RESOLUTION;
}

/** Warmup spans of 0 ms (no clock change read), 30 and then 50: the shortest that read a clock change is 30. */
function warmupSpanMs(sample: number): number {
  return [0, 30][sample] ?? 50;
}

/** Returns the Error a call throws, failing the test when it throws nothing or a non-Error. */
function errorOf(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("threw a non-Error value", { cause: error });
  }
  throw new Error("did not throw");
}

describe("sampleSharedState", () => {
  describe("stopping rule", () => {
    describe("when samples are long", () => {
      it("runs 16 warmup samples", () => {
        const fake = harness(() => 100);

        run(fake, FINE_RESOLUTION);

        expect(fake.collectsAt).toStrictEqual([16]);
      });

      it("runs 64 timed samples", () => {
        const fake = harness(() => 100);

        const result = run(fake, FINE_RESOLUTION);

        expect(result.sampleCount).toBe(64);
        expect(fake.sampleCalls).toHaveLength(80);
      });
    });

    describe("when samples are short", () => {
      it("runs warmup samples until 250 ms have passed", () => {
        const fake = harness(() => 0.75);

        run(fake, FINE_RESOLUTION);

        expect(fake.collectsAt).toStrictEqual([334]);
      });

      it("runs timed samples until 1000 ms have passed", () => {
        const fake = harness(() => 0.75);

        const result = run(fake, FINE_RESOLUTION);

        expect(result.sampleCount).toBe(1334);
      });
    });
  });

  describe("calls per sample", () => {
    it.each([
      {
        rule: "a sample under 200 times the resolution scales the count by 200 / multiples, rounded up",
        costMs: () => 3 * COARSE_RESOLUTION,
        expected: [1, 67, 67],
      },
      {
        rule: "a sample spanning no clock change multiplies the count by 100",
        costMs: (sample: number) => (sample === 0 ? 0 : COARSE_RESOLUTION / 2),
        expected: [1, 100, 400, 400],
      },
    ])("$rule", ({ costMs, expected }) => {
      const fake = harness(costMs);

      run(fake, COARSE_RESOLUTION);

      expect(fake.sampleCalls.slice(0, expected.length)).toStrictEqual(expected);
    });

    it("runs every timed sample at the count warmup ended on", () => {
      const fake = harness((sample) => (sample === 0 ? 0 : COARSE_RESOLUTION / 2));

      const result = run(fake, COARSE_RESOLUTION);

      const timedCalls = fake.sampleCalls.slice(fake.collectsAt[0]);
      expect(timedCalls).toHaveLength(result.sampleCount);
      expect(new Set(timedCalls)).toStrictEqual(new Set([400]));
      expect(result.callsPerSample).toBe(400);
    });

    describe("when the count would exceed 200 times the resolution of a 0.1 ns body", () => {
      it("fails naming the count asked for and the cap", () => {
        const fake = harness(() => 0);

        const error = errorOf(() => run(fake, CAPPED_STEP));

        expect(error.message).toMatch(/\b1000000\b/);
        expect(error.message).toMatch(/\b30518\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(() => 0);

        errorOf(() => run(fake, CAPPED_STEP));

        expect(fake.sampleCalls).toStrictEqual([1, 100, 10_000]);
      });
    });
  });

  describe("when given a fixed count", () => {
    it("runs every warmup and timed sample at that count", () => {
      const fake = harness(() => COARSE_RESOLUTION);

      const result = run(fake, COARSE_RESOLUTION, { callsPerSample: 7 });

      expect(new Set(fake.sampleCalls)).toStrictEqual(new Set([7]));
      expect(fake.sampleCalls.length).toBeGreaterThan(16 + 64);
      expect(result.callsPerSample).toBe(7);
    });

    it("runs a count above the cap", () => {
      const fake = harness(() => 2 ** -10);

      const result = run(fake, CAPPED_STEP, { callsPerSample: 40_000 });

      expect(result.callsPerSample).toBe(40_000);
    });

    it("takes one timing attempt whatever its samples span", () => {
      const fake = harness((_sample, timed) => (timed ? 0 : COARSE_RESOLUTION));

      const result = run(fake, COARSE_RESOLUTION, { callsPerSample: 7 });

      expect(result.timingAttempts).toBe(1);
      expect(fake.collectsAt).toHaveLength(1);
    });

    it("runs until `time` and `samples` have passed when its samples are as long as warmup's", () => {
      const fake = harness(() => 0.75);

      const result = run(fake, 0.1875, { callsPerSample: 1, minTime: 500, minSamples: 10 });

      expect(result.sampleCount).toBe(667);
    });

    describe("when its samples get shorter than warmup's", () => {
      it.each([
        {
          rule: "the shortest warmup sample that read a clock change",
          resolutionMs: 0.1875,
          warmupMs: warmupSpanMs,
          expected: 27,
        },
        {
          rule: "one resolution when no warmup sample read a clock change",
          resolutionMs: 100,
          warmupMs: () => 25,
          expected: 15,
        },
      ])(
        "stops at the store's size, `time` in samples of $rule, rounded up, plus `samples`",
        ({ resolutionMs, warmupMs, expected }) => {
          const fake = harness((sample, timed) => (timed ? 0.75 : warmupMs(sample)));

          const result = run(fake, resolutionMs, {
            callsPerSample: 1,
            minTime: 500,
            minSamples: 10,
          });

          expect(result.spans).toBeInstanceOf(Float64Array);
          expect(result.spans).toHaveLength(expected);
          expect(result.sampleCount).toBe(expected);
        },
      );

      it("reports the run's length when it fills its store before `time` has passed", () => {
        const fake = harness((sample, timed) => (timed ? 0.75 : warmupSpanMs(sample)));

        const result = run(fake, 0.1875, { callsPerSample: 1, minTime: 500, minSamples: 10 });

        expect(result.timingMs).toBe(20.25);
      });
    });
  });

  describe("when calibrating the count", () => {
    it("sizes the store to `time` in samples of 200 times the resolution, rounded up, plus `samples`", () => {
      const fake = harness(() => 100);

      const result = run(fake, FINE_RESOLUTION, { minTime: 100.1, minSamples: 10 });

      expect(result.spans).toHaveLength(523);
    });

    it("keeps a run of exactly `samples` samples at `time` 0 whose median spans 200 times the resolution", () => {
      const fake = harness(() => coarse(40));

      const result = run(fake, COARSE_RESOLUTION, { minTime: 0, minSamples: 10 });

      expect(result.sampleCount).toBe(10);
      expect(result.timingAttempts).toBe(1);
    });
  });

  describe("timing attempts", () => {
    describe("median sample", () => {
      it("is the upper of the two middle samples of an even count", () => {
        const fake = harness((sample, timed) => {
          if (!timed) return COARSE_RESOLUTION;
          return sample % 2 === 0 ? 0.25 : COARSE_RESOLUTION / 2;
        });

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.sampleCount).toBe(64);
        expect(result.timingAttempts).toBe(1);
      });

      it.each([
        { multiples: 199.75, timingAttempts: 1 },
        { multiples: 199.25, timingAttempts: 2 },
      ])(
        "counts $multiples multiples of the resolution as rounded, taking $timingAttempts runs",
        ({ multiples, timingAttempts }) => {
          const fake = harness((_sample, timed) =>
            timed ? coarse(multiples) / 200 : COARSE_RESOLUTION,
          );

          const result = run(fake, COARSE_RESOLUTION);

          expect(result.timingAttempts).toBe(timingAttempts);
        },
      );
    });

    describe("when the body gets faster after warmup settled the count", () => {
      /**
       * Costs one coarse resolution a call in warmup, then 0.75 times the resolution, so the first timing attempt is
       * discarded and the second kept.
       */
      const fasterWhenTimed: CostMs = (sample, timed, timingRun) => {
        if (!timed) return COARSE_RESOLUTION;
        return timingRun === 1 ? coarse(0.75) : coarse(0.75 + (sample % 5) / 1000);
      };

      it("returns the last run's spans alone, in order", () => {
        const fake = harness(fasterWhenTimed);

        const result = run(fake, COARSE_RESOLUTION);

        expect(Array.from(result.spans.subarray(0, result.sampleCount))).toStrictEqual(
          fake.sampleSpans.slice(fake.collectsAt[1]),
        );
      });

      it("reports the count every sample of the last run ran", () => {
        const fake = harness(fasterWhenTimed);

        const result = run(fake, COARSE_RESOLUTION);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[1]))).toStrictEqual(
          new Set([result.callsPerSample]),
        );
      });
    });

    describe("when a run fills its store with a median sample of 200 times the resolution", () => {
      it("discards that run", () => {
        const fake = harness(
          slowerAfterFirstRun((sample) => (sample % 2 === 0 ? coarse(40) : coarse(0.2))),
        );

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.timingAttempts).toBe(2);
      });

      it("times the next run at least one call larger when its shortest sample spans 200 times the resolution", () => {
        const resolutionMs = 2 ** -14;
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return 400 * resolutionMs;
          return timingRun === 1 ? 199.75 * resolutionMs : 150 * resolutionMs;
        });

        const result = run(fake, resolutionMs);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[1]))).toStrictEqual(new Set([2]));
        expect(result.timingAttempts).toBe(2);
      });
    });

    describe("next count", () => {
      it.each([
        {
          rule: "scales the run's count to its shortest sample's 200 times the resolution, rounded up",
          firstRun: shortestFirstRun,
          expected: 10,
        },
        {
          rule: "leaves out samples that read no clock change",
          firstRun: (sample: number) => {
            if (sample % 10 === 2) return 0;
            return coarse(sample % 10 === 1 ? 21.6 : 30);
          },
          expected: 10,
        },
        {
          rule: "multiplies the count by 100 when no sample read a clock change",
          firstRun: () => 0,
          expected: 500,
        },
      ])("$rule", ({ firstRun, expected }) => {
        const fake = harness(slowerAfterFirstRun(firstRun));

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.callsPerSample).toBe(expected);
      });

      it("reads only the discarded run's samples, not an earlier run's left in the store", () => {
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return coarse(40);
          if (timingRun === 1) return coarse(10);
          return timingRun === 2 ? coarse(7.5) : coarse(10);
        });

        const result = run(fake, COARSE_RESOLUTION);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[2]))).toStrictEqual(new Set([27]));
        expect(result.timingAttempts).toBe(3);
      });
    });

    it("collects before every timing attempt, never inside one", () => {
      const fake = harness(slowerAfterFirstRun(shortestFirstRun));

      run(fake, COARSE_RESOLUTION);

      const [warmupEnd, firstRunEnd] = fake.collectsAt;
      expect(fake.collectsAt).toHaveLength(2);
      expect(new Set(fake.sampleCalls.slice(warmupEnd, firstRunEnd))).toStrictEqual(new Set([5]));
      expect(new Set(fake.sampleCalls.slice(firstRunEnd))).toStrictEqual(new Set([10]));
    });

    describe("when a grown count passes the cap", () => {
      const pastCap = shortRuns([{ calls: 200, shortSteps: 1 }]);

      it("fails naming the count asked for and the cap", () => {
        const fake = harness(pastCap);

        const error = errorOf(() => run(fake, CAPPED_STEP));

        expect(error.message).toMatch(/\b40000\b/);
        expect(error.message).toMatch(/\b30518\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(pastCap);

        errorOf(() => run(fake, CAPPED_STEP));

        expect(fake.sampleCalls).not.toContain(40_000);
      });

      it("fails with the cap's error after the third run", () => {
        const fake = harness(
          shortRuns([
            { calls: 200, shortSteps: 40 },
            { calls: 1000, shortSteps: 40 },
            { calls: 5000, shortSteps: 20 },
          ]),
        );

        const error = errorOf(() => run(fake, CAPPED_STEP));

        expect(error.message).toMatch(/\b50000\b/);
        expect(error.message).toMatch(/\b30518\b/);
      });
    });

    describe("when the third run is discarded within the cap", () => {
      it("fails naming the count needed and the runs taken", () => {
        const fake = harness(fasterEveryRun);

        const error = errorOf(() => run(fake, COARSE_RESOLUTION));

        expect(error.message).toMatch(/\b40\b/);
        expect(error.message).toMatch(/\b3\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(fasterEveryRun);

        errorOf(() => run(fake, COARSE_RESOLUTION));

        expect(fake.sampleCalls).toContain(20);
        expect(fake.sampleCalls).not.toContain(40);
      });
    });

    it.each([
      { when: "warmup's count passes the cap", costMs: () => 0, resolutionMs: CAPPED_STEP },
      {
        when: "a grown count passes the cap",
        costMs: shortRuns([{ calls: 200, shortSteps: 1 }]),
        resolutionMs: CAPPED_STEP,
      },
      {
        when: "the third run is discarded within the cap",
        costMs: fasterEveryRun,
        resolutionMs: COARSE_RESOLUTION,
      },
    ])("fails with a CalibrationError when $when", ({ costMs, resolutionMs }) => {
      const fake = harness(costMs);

      const error = errorOf(() => run(fake, resolutionMs));

      expect(error).toBeInstanceOf(CalibrationError);
    });

    describe("when a run is discarded", () => {
      it("counts the discarded run's samples among warmup's", () => {
        const fake = harness(discardedFirstRun);

        const result = run(fake, FINE_RESOLUTION);

        expect(result.warmupSamples).toBe(80);
      });

      it("counts the samples of every discarded run among warmup's", () => {
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return coarse(40);
          if (timingRun === 1) return coarse(10);
          return timingRun === 2 ? coarse(7.5) : coarse(10);
        });

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.timingAttempts).toBe(3);
        expect(result.warmupSamples).toBe(fake.collectsAt[2]);
      });

      it("reports the kept run's length alone", () => {
        const fake = harness(discardedFirstRun);

        const result = run(fake, FINE_RESOLUTION);

        expect(result.timingMs).toBe(128_000);
      });
    });

    describe("afterTiming", () => {
      it("runs after each run's last sample, before the next collection", () => {
        const fake = harness(slowerAfterFirstRun(shortestFirstRun));

        run(fake, COARSE_RESOLUTION, { afterTiming: true });

        expect(fake.events).toStrictEqual(["collect", "afterTiming", "collect", "afterTiming"]);
        expect(fake.afterTimingAt).toStrictEqual([fake.collectsAt[1], fake.sampleCalls.length]);
      });

      it("runs once per run before the limit's error", () => {
        const fake = harness(fasterEveryRun);

        errorOf(() => run(fake, COARSE_RESOLUTION, { afterTiming: true }));

        expect(fake.afterTimingAt).toHaveLength(3);
      });
    });
  });

  it("passes the caller's one state to every body call", () => {
    const fake = harness(() => 100);
    const state: World = { name: "world" };

    sampleSharedState({
      now: fake.now,
      resolutionMs: FINE_RESOLUTION,
      fn: fake.fn,
      state,
      collect: fake.collect,
      minTime: 1000,
      minSamples: 64,
    });

    expect(fake.states).toStrictEqual(new Set([state]));
  });

  describe("when given no clock or resolution", () => {
    it("times on performance.now", () => {
      const state = { total: 0 };
      let collections = 0;

      const result = sampleSharedState({
        fn: (world: { total: number }) => {
          world.total += 1;
        },
        state,
        collect: () => {
          collections += 1;
        },
        minTime: 1000,
        minSamples: 64,
      });

      expect(collections).toBe(result.timingAttempts);
      expect(result.sampleCount).toBeGreaterThanOrEqual(64);
      expect(state.total).toBeGreaterThanOrEqual(result.sampleCount * result.callsPerSample);
    });
  });
});
