import { describe, expect, it } from "vitest";

import { sampleSharedContext, type SamplerResult } from "../../src/measure/shared-context.js";
import { COARSE_STEP, FINE_STEP } from "./fixtures.js";

interface World {
  readonly name: string;
}

interface Harness {
  readonly now: () => number;
  readonly fn: (context: World) => void;
  readonly collect: () => void;
  readonly afterTiming: () => void;
  readonly sampleCalls: number[];
  readonly sampleSpans: number[];
  readonly collectsAt: number[];
  readonly afterTimingAt: number[];
  readonly events: string[];
  readonly contexts: Set<World>;
}

/** The body's cost per call: `run` is 0 during warmup and the timing run's number after. */
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
  const contexts = new Set<World>();
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
    fn: (context) => {
      contexts.add(context);
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
    contexts,
  };
}

interface RunOptions {
  readonly callsPerSample?: number;
  readonly afterTiming?: boolean;
  readonly time?: number;
  readonly samples?: number;
}

/** Runs the sampler on a harness with a fresh context, for 1000 ms and 64 samples unless given. */
function run(fake: Harness, stepMs: number, options: RunOptions = {}): SamplerResult {
  const context: World = { name: "world" };
  return sampleSharedContext({
    now: fake.now,
    stepMs,
    fn: fake.fn,
    context,
    collect: fake.collect,
    time: options.time ?? 1000,
    samples: options.samples ?? 64,
    ...(options.callsPerSample === undefined ? {} : { callsPerSample: options.callsPerSample }),
    ...(options.afterTiming === true ? { afterTiming: fake.afterTiming } : {}),
  });
}

/** Milliseconds spanning `count` coarse timer steps. */
function coarse(count: number): number {
  return count * COARSE_STEP;
}

/**
 * Costs 40 coarse steps a call during warmup and from the second timing run on, so warmup settles
 * on 5 calls per sample, and `firstRun` a call during the first timing run.
 */
function slowerAfterFirstRun(firstRun: (sample: number) => number): CostMs {
  return (sample, _timed, timingRun) => (timingRun === 1 ? firstRun(sample) : coarse(40));
}

/**
 * Costs 21.6 coarse steps a call on every tenth sample and 30 on the rest, so a first run of 5 calls
 * per sample is discarded and its shortest sample grows the count to 10.
 */
function shortestFirstRun(sample: number): number {
  return coarse(sample % 10 === 0 ? 21.6 : 30);
}

/** A timer step whose cap, `ceil(200 × step / 0.1 ns)`, is 30518 calls. */
const CAPPED_STEP = 2 ** -16;

/**
 * Costs one capped step a call for the first warmup sample and 0.25 ms after, so warmup settles on
 * 200 calls; then, per timing run, one sample in three spans 50 ms and the others span the run's
 * short step count, so each run's median falls under 200 steps.
 */
function shortRuns(runs: readonly { calls: number; shortSteps: number }[]): CostMs {
  return (sample, _timed, timingRun) => {
    if (timingRun === 0) return sample === 0 ? CAPPED_STEP : 0.25;
    const { calls, shortSteps } = runs[timingRun - 1] ?? { calls: 1, shortSteps: 1000 };
    return sample % 3 === 0 ? 50 / calls : (shortSteps * CAPPED_STEP) / calls;
  };
}

/** Costs 40 coarse steps a call in warmup, then halves per timing run so every run spans 100 steps. */
function fasterEveryRun(_sample: number, _timed: boolean, timingRun: number): number {
  return timingRun === 0 ? coarse(40) : coarse(20 / 2 ** (timingRun - 1));
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

describe("sampleSharedContext", () => {
  describe("stopping rule", () => {
    describe("when samples are long", () => {
      it("runs 16 warmup samples", () => {
        const fake = harness(() => 100);

        run(fake, FINE_STEP);

        expect(fake.collectsAt).toStrictEqual([16]);
      });

      it("runs 64 timed samples", () => {
        const fake = harness(() => 100);

        const result = run(fake, FINE_STEP);

        expect(result.samples).toBe(64);
        expect(fake.sampleCalls).toHaveLength(80);
      });
    });

    describe("when samples are short", () => {
      it("runs warmup samples until 250 ms have passed", () => {
        const fake = harness(() => 0.75);

        run(fake, FINE_STEP);

        expect(fake.collectsAt).toStrictEqual([334]);
      });

      it("runs timed samples until 1000 ms have passed", () => {
        const fake = harness(() => 0.75);

        const result = run(fake, FINE_STEP);

        expect(result.samples).toBe(1334);
      });
    });
  });

  describe("calls per sample", () => {
    it.each([
      {
        rule: "a sample under 200 steps scales the count by 200 / steps, rounded up",
        costMs: () => 3 * COARSE_STEP,
        expected: [1, 67, 67],
      },
      {
        rule: "a sample spanning no step multiplies the count by 100",
        costMs: (sample: number) => (sample === 0 ? 0 : COARSE_STEP / 2),
        expected: [1, 100, 400, 400],
      },
    ])("$rule", ({ costMs, expected }) => {
      const fake = harness(costMs);

      run(fake, COARSE_STEP);

      expect(fake.sampleCalls.slice(0, expected.length)).toStrictEqual(expected);
    });

    it("runs every timed sample at the count warmup ended on", () => {
      const fake = harness((sample) => (sample === 0 ? 0 : COARSE_STEP / 2));

      const result = run(fake, COARSE_STEP);

      const timedCalls = fake.sampleCalls.slice(fake.collectsAt[0]);
      expect(timedCalls).toHaveLength(result.samples);
      expect(new Set(timedCalls)).toStrictEqual(new Set([400]));
      expect(result.callsPerSample).toBe(400);
    });

    describe("when the count would exceed 200 steps of a 0.1 ns body", () => {
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
      const fake = harness(() => COARSE_STEP);

      const result = run(fake, COARSE_STEP, { callsPerSample: 7 });

      expect(new Set(fake.sampleCalls)).toStrictEqual(new Set([7]));
      expect(fake.sampleCalls.length).toBeGreaterThan(16 + 64);
      expect(result.callsPerSample).toBe(7);
    });

    it("runs a count above the cap", () => {
      const fake = harness(() => 2 ** -10);

      const result = run(fake, CAPPED_STEP, { callsPerSample: 40_000 });

      expect(result.callsPerSample).toBe(40_000);
    });

    it("takes one timing run whatever its samples span", () => {
      const fake = harness((_sample, timed) => (timed ? 0 : COARSE_STEP));

      const result = run(fake, COARSE_STEP, { callsPerSample: 7 });

      expect(result.timingRuns).toBe(1);
      expect(fake.collectsAt).toHaveLength(1);
    });

    it("runs until `time` and `samples` have passed when its samples are as long as warmup's", () => {
      const fake = harness(() => 0.75);

      const result = run(fake, 0.1875, { callsPerSample: 1, time: 500, samples: 10 });

      expect(result.samples).toBe(667);
    });

    describe("when its samples get shorter than warmup's", () => {
      it.each([
        {
          rule: "the shortest warmup sample that read a step",
          stepMs: 0.1875,
          warmupMs: (sample: number) => [0, 30][sample] ?? 50,
          expected: 27,
        },
        {
          rule: "one step when no warmup sample read one",
          stepMs: 100,
          warmupMs: () => 25,
          expected: 15,
        },
      ])(
        "stops at the store's size, `time` in samples of $rule, rounded up, plus `samples`",
        ({ stepMs, warmupMs, expected }) => {
          const fake = harness((sample, timed) => (timed ? 0.75 : warmupMs(sample)));

          const result = run(fake, stepMs, { callsPerSample: 1, time: 500, samples: 10 });

          expect(result.spans).toBeInstanceOf(Float64Array);
          expect(result.spans).toHaveLength(expected);
          expect(result.samples).toBe(expected);
        },
      );
    });
  });

  describe("when calibrating the count", () => {
    it("sizes the store to `time` in 200-step samples, rounded up, plus `samples`", () => {
      const fake = harness(() => 100);

      const result = run(fake, FINE_STEP, { time: 100.1, samples: 10 });

      expect(result.spans).toHaveLength(523);
    });

    it("keeps a run of exactly `samples` samples at `time` 0 whose median spans 200 steps", () => {
      const fake = harness(() => coarse(40));

      const result = run(fake, COARSE_STEP, { time: 0, samples: 10 });

      expect(result.samples).toBe(10);
      expect(result.timingRuns).toBe(1);
    });
  });

  describe("timing runs", () => {
    describe("median sample", () => {
      it("is the upper of the two middle samples of an even count", () => {
        const fake = harness((sample, timed) => {
          if (!timed) return COARSE_STEP;
          return sample % 2 === 0 ? 0.25 : COARSE_STEP / 2;
        });

        const result = run(fake, COARSE_STEP);

        expect(result.samples).toBe(64);
        expect(result.timingRuns).toBe(1);
      });

      it.each([
        { steps: 199.75, timingRuns: 1 },
        { steps: 199.25, timingRuns: 2 },
      ])("counts $steps steps as rounded, taking $timingRuns runs", ({ steps, timingRuns }) => {
        const fake = harness((_sample, timed) => (timed ? coarse(steps) / 200 : COARSE_STEP));

        const result = run(fake, COARSE_STEP);

        expect(result.timingRuns).toBe(timingRuns);
      });
    });

    describe("when the body gets faster after warmup settled the count", () => {
      /**
       * Costs one coarse step a call in warmup, then 0.75 steps, so the first timing run is
       * discarded and the second kept.
       */
      const fasterWhenTimed: CostMs = (sample, timed, timingRun) => {
        if (!timed) return COARSE_STEP;
        return timingRun === 1 ? coarse(0.75) : coarse(0.75 + (sample % 5) / 1000);
      };

      it("returns the last run's spans alone, in order", () => {
        const fake = harness(fasterWhenTimed);

        const result = run(fake, COARSE_STEP);

        expect(Array.from(result.spans.subarray(0, result.samples))).toStrictEqual(
          fake.sampleSpans.slice(fake.collectsAt[1]),
        );
      });

      it("reports the count every sample of the last run ran", () => {
        const fake = harness(fasterWhenTimed);

        const result = run(fake, COARSE_STEP);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[1]))).toStrictEqual(
          new Set([result.callsPerSample]),
        );
      });
    });

    describe("when a run fills its store with a median sample of 200 steps", () => {
      it("discards that run", () => {
        const fake = harness(
          slowerAfterFirstRun((sample) => (sample % 2 === 0 ? coarse(40) : coarse(0.2))),
        );

        const result = run(fake, COARSE_STEP);

        expect(result.timingRuns).toBe(2);
      });

      it("times the next run at least one call larger when its shortest sample spans 200 steps", () => {
        const stepMs = 2 ** -14;
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return 400 * stepMs;
          return timingRun === 1 ? 199.75 * stepMs : 150 * stepMs;
        });

        const result = run(fake, stepMs);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[1]))).toStrictEqual(new Set([2]));
        expect(result.timingRuns).toBe(2);
      });
    });

    describe("next count", () => {
      it.each([
        {
          rule: "scales the run's count to its shortest sample's 200 steps, rounded up",
          firstRun: shortestFirstRun,
          expected: 10,
        },
        {
          rule: "leaves out samples that read no step",
          firstRun: (sample: number) => {
            if (sample % 10 === 2) return 0;
            return coarse(sample % 10 === 1 ? 21.6 : 30);
          },
          expected: 10,
        },
        {
          rule: "multiplies the count by 100 when no sample read a step",
          firstRun: () => 0,
          expected: 500,
        },
      ])("$rule", ({ firstRun, expected }) => {
        const fake = harness(slowerAfterFirstRun(firstRun));

        const result = run(fake, COARSE_STEP);

        expect(result.callsPerSample).toBe(expected);
      });

      it("reads only the discarded run's samples, not an earlier run's left in the store", () => {
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return coarse(40);
          if (timingRun === 1) return coarse(10);
          return timingRun === 2 ? coarse(7.5) : coarse(10);
        });

        const result = run(fake, COARSE_STEP);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[2]))).toStrictEqual(new Set([27]));
        expect(result.timingRuns).toBe(3);
      });
    });

    it("collects before every timing run, never inside one", () => {
      const fake = harness(slowerAfterFirstRun(shortestFirstRun));

      run(fake, COARSE_STEP);

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

        const error = errorOf(() => run(fake, COARSE_STEP));

        expect(error.message).toMatch(/\b40\b/);
        expect(error.message).toMatch(/\b3\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(fasterEveryRun);

        errorOf(() => run(fake, COARSE_STEP));

        expect(fake.sampleCalls).toContain(20);
        expect(fake.sampleCalls).not.toContain(40);
      });
    });

    describe("afterTiming", () => {
      it("runs after each run's last sample, before the next collection", () => {
        const fake = harness(slowerAfterFirstRun(shortestFirstRun));

        run(fake, COARSE_STEP, { afterTiming: true });

        expect(fake.events).toStrictEqual(["collect", "afterTiming", "collect", "afterTiming"]);
        expect(fake.afterTimingAt).toStrictEqual([fake.collectsAt[1], fake.sampleCalls.length]);
      });

      it("runs once per run before the limit's error", () => {
        const fake = harness(fasterEveryRun);

        errorOf(() => run(fake, COARSE_STEP, { afterTiming: true }));

        expect(fake.afterTimingAt).toHaveLength(3);
      });
    });
  });

  it("passes the caller's one context to every body call", () => {
    const fake = harness(() => 100);
    const context: World = { name: "world" };

    sampleSharedContext({
      now: fake.now,
      stepMs: FINE_STEP,
      fn: fake.fn,
      context,
      collect: fake.collect,
      time: 1000,
      samples: 64,
    });

    expect(fake.contexts).toStrictEqual(new Set([context]));
  });

  describe("when given no clock or step", () => {
    it("times on performance.now", () => {
      const context = { total: 0 };
      let collections = 0;

      const result = sampleSharedContext({
        fn: (world: { total: number }) => {
          world.total += 1;
        },
        context,
        collect: () => {
          collections += 1;
        },
        time: 1000,
        samples: 64,
      });

      expect(collections).toBe(result.timingRuns);
      expect(result.samples).toBeGreaterThanOrEqual(64);
      expect(context.total).toBeGreaterThanOrEqual(result.samples * result.callsPerSample);
    });
  });
});
