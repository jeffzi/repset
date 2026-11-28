import { describe, expect, it } from "vitest";

import {
  type InFlight,
  samplePerCall,
  sampleSharedState,
  type SamplerResult,
} from "../../src/measure/sampler.js";
import { errorOf } from "../helpers/error-of.js";
import {
  COARSE_RESOLUTION,
  FINE_RESOLUTION,
  type RecordedLifecycle,
  type RecordedWorld,
  recordedLifecycle,
} from "./fixtures.js";

interface World {
  readonly name: string;
}

interface Harness {
  readonly now: () => number;
  readonly fn: (state: World) => void;
  readonly collect: () => void;
  readonly sampleCalls: number[];
  readonly sampleSpans: number[];
  readonly collectsAt: number[];
}

/** The body's cost per call: `run` is 0 during warmup and the timing attempt's number after. */
type CostMs = (sample: number, timed: boolean, run: number) => number;

/**
 * Builds a virtual clock that only the body advances, recording the body calls and the span
 * between clock reads.
 *
 * @param costMs - The body's cost per call.
 * @returns The harness's clock, body, collector and recordings.
 */
function harness(costMs: CostMs): Harness {
  let time = 1000;
  let lastRead = time;
  let pending = 0;
  const sampleCalls: number[] = [];
  const sampleSpans: number[] = [];
  const collectsAt: number[] = [];
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
    fn: () => {
      time += costMs(sampleCalls.length, collectsAt.length > 0, collectsAt.length);
      pending += 1;
    },
    collect: () => {
      collectsAt.push(sampleCalls.length);
    },
    sampleCalls,
    sampleSpans,
    collectsAt,
  };
}

interface RunOptions {
  readonly callsPerSample?: number;
  readonly minTime?: number;
  readonly minSamples?: number;
}

/** A run's sampler minimums, 1000 ms and 64 samples unless given, and its fixed count when given. */
function samplingOptions(options: RunOptions): {
  readonly minTime: number;
  readonly minSamples: number;
  readonly callsPerSample?: number;
} {
  return {
    minTime: options.minTime ?? 1000,
    minSamples: options.minSamples ?? 64,
    ...(options.callsPerSample === undefined ? {} : { callsPerSample: options.callsPerSample }),
  };
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
    ...samplingOptions(options),
  });
}

/** Milliseconds spanning `count` multiples of the coarse resolution. */
function coarse(count: number): number {
  return count * COARSE_RESOLUTION;
}

/**
 * Costs 40 times the resolution a call during warmup and from the second timing attempt on, so warmup settles
 * on 5 calls per sample, and `firstRun` a call during the first timing attempt.
 *
 * @param firstRun - The cost per call during the first timing attempt, given the sample's index.
 * @returns The cost function.
 */
function slowerAfterFirstRun(firstRun: (sample: number) => number): CostMs {
  return (sample, _timed, timingRun) => (timingRun === 1 ? firstRun(sample) : coarse(40));
}

/** A timer resolution whose cap, `ceil(200 × resolution / 0.1 ns)`, is 30518 calls. */
const CAPPED_STEP = 2 ** -16;

/**
 * Costs one capped resolution a call for the first warmup sample and 0.25 ms after, so warmup settles on
 * 200 calls; then, per timing attempt, one sample in three spans 50 ms and the others span the run's
 * short multiple of the resolution, so each run's median falls under 200 times the resolution.
 *
 * @param runs - Each timing attempt's calls per sample and the short samples' multiple of the capped resolution.
 * @returns The cost function.
 */
function shortRuns(runs: readonly { calls: number; shortSteps: number }[]): CostMs {
  return (sample, _timed, timingRun) => {
    if (timingRun === 0) return sample === 0 ? CAPPED_STEP : 0.25;
    const { calls, shortSteps } = runs[timingRun - 1] ?? { calls: 1, shortSteps: 1000 };
    return sample % 3 === 0 ? 50 / calls : (shortSteps * CAPPED_STEP) / calls;
  };
}

/**
 * Costs 40 times the resolution a call in warmup, then halves per timing attempt so every run spans 100 times the resolution.
 *
 * @param _sample - Unused: the cost does not depend on the sample.
 * @param _timed - Unused: the cost follows `timingRun`.
 * @param timingRun - The timing attempt's number, 0 during warmup.
 * @returns The body's cost per call, in milliseconds.
 */
function fasterEveryRun(_sample: number, _timed: boolean, timingRun: number): number {
  return timingRun === 0 ? coarse(40) : coarse(20 / 2 ** (timingRun - 1));
}

/**
 * Costs 100 ms a call outside the first timing attempt, so warmup runs 16 samples of one call; in the
 * first run, 50 ms on every third sample and 10 times the resolution on the rest, so its 64 samples are
 * discarded and the count grows to 20 for a kept second run of 64 samples of 2000 ms.
 *
 * @param sample - The index of the sample the call belongs to.
 * @param _timed - Unused: the cost follows `timingRun`.
 * @param timingRun - The timing attempt's number, 0 during warmup.
 * @returns The body's cost per call, in milliseconds.
 */
function discardedFirstRun(sample: number, _timed: boolean, timingRun: number): number {
  if (timingRun !== 1) return 100;
  return sample % 3 === 0 ? 50 : 10 * FINE_RESOLUTION;
}

/**
 * Costs 40 times the resolution a call in warmup, then 10, 7.5 and 10 times the resolution a call in
 * timing attempts 1, 2 and 3.
 *
 * @param _sample - Unused: the cost does not depend on the sample.
 * @param _timed - Unused: the cost follows `timingRun`.
 * @param timingRun - The timing attempt's number, 0 during warmup.
 * @returns The body's cost per call, in milliseconds.
 */
function discardedTwice(_sample: number, _timed: boolean, timingRun: number): number {
  if (timingRun === 0) return coarse(40);
  return coarse(timingRun === 2 ? 7.5 : 10);
}

/**
 * Warmup spans of 0 ms (no clock change read), 30 and then 50: the shortest that read a clock change is 30.
 *
 * @param sample - The index of the warmup sample.
 * @returns The sample's span, in milliseconds.
 */
function warmupSpanMs(sample: number): number {
  return [0, 30][sample] ?? 50;
}

const FIXED_SHORT_RUN: RunOptions = { callsPerSample: 1, minTime: 500, minSamples: 10 };

describe("sampleSharedState", () => {
  describe("when deciding when to stop sampling", () => {
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

  describe("when choosing the calls per sample", () => {
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

    it("runs a count warmup asks for that equals the cap", () => {
      // The cap at 2^-22 ms is ceil(200 × 2^-22 / 1e-7) = 477 calls. One call spans no clock change,
      // so warmup asks for 100; 100 calls span 42 resolutions, so it asks for ceil(20000 / 42) = 477.
      const resolution = 2 ** -22;
      const fake = harness((sample) => {
        if (sample === 0) return 0;
        if (sample === 1) return (42 * resolution) / 100;
        return 0.01;
      });

      const result = run(fake, resolution, { minTime: 1 });

      expect(result.callsPerSample).toBe(477);
    });

    describe("when warmup's count would pass the cap", () => {
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

      run(fake, COARSE_RESOLUTION, { callsPerSample: 7 });

      expect(new Set(fake.sampleCalls)).toStrictEqual(new Set([7]));
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
        "stops at the store's size, `minTime` in samples of $rule, rounded up, plus `minSamples`",
        ({ resolutionMs, warmupMs, expected }) => {
          const fake = harness((sample, timed) => (timed ? 0.75 : warmupMs(sample)));

          const result = run(fake, resolutionMs, FIXED_SHORT_RUN);

          expect(result.sampleCount).toBe(expected);
        },
      );
    });
  });

  describe("when calibrating the count", () => {
    it("stops a run that cannot pass `minTime` at the store's size, `minTime` in samples of 200 times the resolution, rounded up, plus `minSamples`", () => {
      const fake = harness((_sample, _timed, timingRun) => (timingRun === 1 ? 0.125 : 100));

      run(fake, FINE_RESOLUTION, { minTime: 100.1, minSamples: 10 });

      expect(fake.sampleCalls.slice(fake.collectsAt[0], fake.collectsAt[1])).toHaveLength(523);
    });

    it("keeps a run of exactly `minSamples` samples at `minTime` 0 whose median spans 200 times the resolution", () => {
      const fake = harness(() => coarse(40));

      const result = run(fake, COARSE_RESOLUTION, { minTime: 0, minSamples: 10 });

      expect(result.timingAttemptCount).toBe(1);
    });
  });

  describe("when repeating timing attempts", () => {
    describe("when taking a run's median sample", () => {
      it("is the upper of the two middle samples of an even count", () => {
        const fake = harness((sample, timed) => {
          if (!timed) return COARSE_RESOLUTION;
          return sample % 2 === 0 ? 0.25 : COARSE_RESOLUTION / 2;
        });

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.timingAttemptCount).toBe(1);
      });

      it.each([
        { multiples: 199.75, timingAttemptCount: 1 },
        { multiples: 199.25, timingAttemptCount: 2 },
      ])(
        "counts $multiples multiples of the resolution as rounded, taking $timingAttemptCount runs",
        ({ multiples, timingAttemptCount }) => {
          const fake = harness((_sample, timed) =>
            timed ? coarse(multiples) / 200 : COARSE_RESOLUTION,
          );

          const result = run(fake, COARSE_RESOLUTION);

          expect(result.timingAttemptCount).toBe(timingAttemptCount);
        },
      );
    });

    describe("when the body gets faster after warmup settled the count", () => {
      /**
       * Costs one coarse resolution a call in warmup, then 0.75 times the resolution, so the first timing attempt is
       * discarded and the second kept.
       *
       * @param sample - The index of the sample the call belongs to.
       * @param timed - Whether a collection has run, which ends warmup.
       * @param timingRun - The timing attempt's number, 0 during warmup.
       * @returns The body's cost per call, in milliseconds.
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
    });

    describe("when a run fills its store with a median sample of 200 times the resolution", () => {
      it("discards that run", () => {
        const fake = harness(
          slowerAfterFirstRun((sample) => (sample % 2 === 0 ? coarse(40) : coarse(0.2))),
        );

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.timingAttemptCount).toBe(2);
      });

      it("times the next run at least one call larger when its shortest sample spans 200 times the resolution", () => {
        const resolutionMs = 2 ** -14;
        const fake = harness((_sample, _timed, timingRun) => {
          if (timingRun === 0) return 400 * resolutionMs;
          return timingRun === 1 ? 199.75 * resolutionMs : 150 * resolutionMs;
        });

        const result = run(fake, resolutionMs);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[1]))).toStrictEqual(new Set([2]));
        expect(result.timingAttemptCount).toBe(2);
      });
    });

    describe("when growing the count for the next attempt", () => {
      it.each([
        {
          rule: "scales the run's count to its shortest sample's 200 times the resolution, rounded up, leaving out samples that read no clock change",
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
        const fake = harness(discardedTwice);

        run(fake, COARSE_RESOLUTION);

        expect(new Set(fake.sampleCalls.slice(fake.collectsAt[2]))).toStrictEqual(new Set([27]));
      });
    });

    describe("when a grown count passes the cap", () => {
      const pastCap = shortRuns([{ calls: 200, shortSteps: 1 }]);

      it("fails naming the count asked for and the cap", () => {
        const fake = harness(pastCap);

        const error = errorOf(() => run(fake, CAPPED_STEP));

        expect(error.message).toMatch(/\b40000\b/);
        expect(error.message).toMatch(/\b30518\b/);
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
    });

    describe("when a run is discarded", () => {
      it("counts the samples of every discarded run among warmup's", () => {
        const fake = harness(discardedTwice);

        const result = run(fake, COARSE_RESOLUTION);

        expect(result.timingAttemptCount).toBe(3);
        expect(result.warmupSampleCount).toBe(fake.collectsAt[2]);
      });

      it("reports the kept run's length alone", () => {
        const fake = harness(discardedFirstRun);

        const result = run(fake, FINE_RESOLUTION);

        expect(result.timingMs).toBe(128_000);
      });
    });
  });
});

interface PerCallCosts {
  readonly bodyMs: (sample: number, timed: boolean) => number;
  readonly buildMs?: number;
  readonly teardownMs?: number;
  readonly throwAt?: number;
  readonly teardownThrowAt?: number;
  readonly setupThrowAt?: number;
}

interface PerCallHarness extends RecordedLifecycle {
  readonly now: () => number;
  readonly collect: () => void;
  readonly failure: Error;
  readonly sampleCalls: number[];
  readonly collectsAt: number[];
}

/**
 * Builds a virtual clock that only setup, fn and teardown advance, recording body calls between
 * clock reads taken with no state alive.
 *
 * @param costs - What each callback charges the clock and the calls at which each one throws.
 * @returns The clock, the lifecycle, and the logs the tests read.
 */
function perCallHarness(costs: PerCallCosts): PerCallHarness {
  let time = 1000;
  let pending = 0;
  const failure = new Error("banana");
  const sampleCalls: number[] = [];
  const collectsAt: number[] = [];
  const lifecycle = recordedLifecycle({
    failAt: { setup: costs.setupThrowAt, fn: costs.throwAt, teardown: costs.teardownThrowAt },
    thrown: { setup: failure, fn: failure, teardown: failure },
    afterSetup: () => {
      time += costs.buildMs ?? 0;
    },
    afterFn: () => {
      time += costs.bodyMs(sampleCalls.length, collectsAt.length > 0);
      pending += 1;
    },
    afterTeardown: () => {
      time += costs.teardownMs ?? 0;
    },
  });
  return {
    ...lifecycle,
    now: () => {
      if (lifecycle.live.size === 0 && pending > 0) {
        sampleCalls.push(pending);
        pending = 0;
      }
      return time;
    },
    collect: () => {
      collectsAt.push(sampleCalls.length);
      pending = 0;
    },
    failure,
    sampleCalls,
    collectsAt,
  };
}

interface PerCallRunOptions extends RunOptions {
  readonly resolutionMs: number;
  readonly inFlight?: InFlight<RecordedWorld>;
}

/**
 * Runs the sampler on a harness.
 *
 * @param fake - The harness whose clock and lifecycle the sampler runs.
 * @param options - The timer resolution; `minTime` and `minSamples`, 1000 ms and 64 unless given;
 *   `callsPerSample`, forwarded only when set; and `inFlight`, a fresh holder unless given.
 * @returns What the sampler returned.
 * @throws Whatever the sampler throws.
 */
function runPerCall(fake: PerCallHarness, options: PerCallRunOptions): SamplerResult {
  return samplePerCall({
    now: fake.now,
    resolutionMs: options.resolutionMs,
    setup: fake.setup,
    fn: fake.fn,
    teardown: fake.teardown,
    collect: fake.collect,
    ...samplingOptions(options),
    inFlight: options.inFlight ?? { held: false, state: undefined },
  });
}

describe("samplePerCall", () => {
  describe("when timing each call", () => {
    it("spans each sample as the sum of its body calls, excluding every setup and teardown", () => {
      const fake = perCallHarness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      const result = runPerCall(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      expect(Array.from(result.spans.subarray(0, result.sampleCount))).toStrictEqual(
        Array.from({ length: 64 }, () => 300),
      );
    });

    it("runs each body call on a fresh state, built before it and torn down after it", () => {
      const fake = perCallHarness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      runPerCall(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      expect(fake.built.length).toBeGreaterThan(1);
      expect(fake.log).toStrictEqual(
        fake.built.flatMap(({ id }) => [`setup ${id}`, `fn ${id}`, `teardown ${id}`]),
      );
    });

    it("reports the run's length, every setup and teardown in it included", () => {
      const fake = perCallHarness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      const result = runPerCall(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      expect(result.timingMs).toBe(38_400);
    });
  });

  describe("when deciding when to stop sampling", () => {
    describe("when samples are long", () => {
      it("runs 16 warmup samples", () => {
        const fake = perCallHarness({ bodyMs: () => 200 });

        runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([16]);
      });

      it("reports warmup's samples, leaving out the forced GC's call", () => {
        const fake = perCallHarness({ bodyMs: () => 200 });

        const result = runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.warmupSampleCount).toBe(16);
      });

      it("runs 64 timed samples", () => {
        const fake = perCallHarness({ bodyMs: () => 200 });

        const result = runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.sampleCount).toBe(64);
      });
    });

    describe("when setup and teardown time dominates each sample's wall time", () => {
      it("runs warmup samples until 3000 ms of wall time have passed", () => {
        const fake = perCallHarness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([273]);
      });

      it("runs timed samples until 1000 ms of wall time have passed", () => {
        const fake = perCallHarness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        const result = runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.sampleCount).toBe(91);
      });
    });

    describe("when samples are short", () => {
      it("stops warmup at 1000 samples", () => {
        const fake = perCallHarness({ bodyMs: (_sample, timed) => (timed ? 0.25 : 1) });

        runPerCall(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([1000]);
      });

      it("stops timing a calibrated count at the store's size, `minTime` in samples of 200 times the resolution, rounded up, plus `minSamples`", () => {
        const fake = perCallHarness({ bodyMs: (_sample, timed) => (timed ? 0.125 : 1) });

        const result = runPerCall(fake, {
          resolutionMs: FINE_RESOLUTION,
          minTime: 100.1,
          minSamples: 10,
        });

        expect(result.sampleCount).toBe(523);
      });
    });
  });

  describe("when choosing the calls per sample", () => {
    it("runs every timed sample at the count warmup ended on", () => {
      const fake = perCallHarness({
        bodyMs: (_sample, timed) => (timed ? 0 : 3 * COARSE_RESOLUTION),
        buildMs: 0.25,
      });

      const result = runPerCall(fake, { resolutionMs: COARSE_RESOLUTION });

      const timedCalls = fake.sampleCalls.slice(fake.collectsAt[0]);
      expect(timedCalls).toHaveLength(result.sampleCount);
      expect(new Set(timedCalls)).toStrictEqual(new Set([67]));
      expect(result.callsPerSample).toBe(67);
    });
  });

  describe("when a callback throws mid-run", () => {
    it.each([
      { when: "the body throws mid-sample", throwAt: 4, samplesBefore: 1, liveCount: 1 },
      {
        when: "the body throws during the forced GC's run",
        throwAt: 48,
        samplesBefore: 16,
        liveCount: 1,
      },
      { when: "a teardown throws mid-sample", teardownThrowAt: 4, samplesBefore: 1, liveCount: 1 },
      {
        when: "the forced GC's teardown throws",
        teardownThrowAt: 48,
        samplesBefore: 16,
        liveCount: 1,
      },
      { when: "a setup throws mid-sample", setupThrowAt: 4, samplesBefore: 1, liveCount: 0 },
    ])(
      "leaves the caller exactly the states built and not torn down when $when",
      ({ samplesBefore, liveCount, ...throws }) => {
        const fake = perCallHarness({ bodyMs: () => 200, ...throws });
        const inFlight: InFlight<RecordedWorld> = { held: false, state: undefined };

        const error = errorOf(() =>
          runPerCall(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3, inFlight }),
        );

        expect(error).toBe(fake.failure);
        expect(fake.sampleCalls).toHaveLength(samplesBefore);
        expect(inFlight.held).toBe(liveCount === 1);
        expect(fake.live).toStrictEqual(new Set(inFlight.held ? [inFlight.state] : []));
      },
    );
  });
});
