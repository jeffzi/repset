import { describe, expect, it } from "vitest";

import { samplePerCall } from "../../src/measure/per-call.js";
import type { SamplerResult } from "../../src/measure/shared-state.js";
import { COARSE_RESOLUTION, FINE_RESOLUTION } from "./fixtures.js";

interface World {
  readonly id: number;
}

interface Costs {
  readonly bodyMs: (sample: number, timed: boolean) => number;
  readonly buildMs?: number;
  readonly teardownMs?: number;
  readonly throwAt?: number;
  readonly teardownThrowAt?: number;
  readonly setupThrowAt?: number;
  readonly collectThrows?: boolean;
}

interface Harness {
  readonly now: () => number;
  readonly setup: () => World;
  readonly fn: (world: World) => void;
  readonly teardown: (world: World) => void;
  readonly collect: () => void;
  readonly failure: Error;
  readonly log: string[];
  readonly built: World[];
  readonly sampleCalls: number[];
  readonly collectsAt: number[];
  readonly live: Set<World>;
}

/**
 * Builds a virtual clock that only setup, fn and teardown advance, recording body calls between
 * clock reads taken with no state alive.
 */
function harness(costs: Costs): Harness {
  let time = 1000;
  let pending = 0;
  let bodyCalls = 0;
  let teardownCalls = 0;
  const failure = new Error("banana");
  const log: string[] = [];
  const built: World[] = [];
  const sampleCalls: number[] = [];
  const collectsAt: number[] = [];
  const live = new Set<World>();
  return {
    now: () => {
      log.push("now");
      if (live.size === 0 && pending > 0) {
        sampleCalls.push(pending);
        pending = 0;
      }
      return time;
    },
    setup: () => {
      if (built.length === costs.setupThrowAt) {
        throw failure;
      }
      const world: World = { id: built.length };
      built.push(world);
      live.add(world);
      log.push(`setup ${world.id}`);
      time += costs.buildMs ?? 0;
      return world;
    },
    fn: (world) => {
      log.push(`fn ${world.id}`);
      if (bodyCalls === costs.throwAt) {
        throw failure;
      }
      bodyCalls += 1;
      time += costs.bodyMs(sampleCalls.length, collectsAt.length > 0);
      pending += 1;
    },
    teardown: (world) => {
      if (teardownCalls === costs.teardownThrowAt) {
        throw failure;
      }
      teardownCalls += 1;
      live.delete(world);
      log.push(`teardown ${world.id}`);
      time += costs.teardownMs ?? 0;
    },
    collect: () => {
      if (costs.collectThrows === true) {
        throw failure;
      }
      log.push("collect");
      collectsAt.push(sampleCalls.length);
      pending = 0;
    },
    failure,
    log,
    built,
    sampleCalls,
    collectsAt,
    live,
  };
}

interface RunOptions {
  readonly resolutionMs: number;
  readonly callsPerSample?: number | undefined;
  readonly slots?: (World | undefined)[];
  readonly minTime?: number;
  readonly minSamples?: number;
}

/**
 * Runs the sampler on a harness for 1000 ms and 64 samples unless given, forwarding
 * `callsPerSample` and `slots` only when set.
 */
function run(fake: Harness, options: RunOptions): SamplerResult {
  return samplePerCall({
    now: fake.now,
    resolutionMs: options.resolutionMs,
    setup: fake.setup,
    fn: fake.fn,
    teardown: fake.teardown,
    collect: fake.collect,
    minTime: options.minTime ?? 1000,
    minSamples: options.minSamples ?? 64,
    ...(options.callsPerSample === undefined ? {} : { callsPerSample: options.callsPerSample }),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
  });
}

/** A timer resolution whose cap, `ceil(200 × resolution / 0.1 ns)`, is 1908 calls. */
const CAPPED_STEP = 2 ** -20;

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

describe("samplePerCall", () => {
  describe("per call", () => {
    it("spans each sample as the sum of its body calls, excluding every setup and teardown", () => {
      const fake = harness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      const result = run(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      expect(Array.from(result.spans.subarray(0, result.sampleCount))).toStrictEqual(
        Array.from({ length: 64 }, () => 300),
      );
    });

    it("runs each body call on a fresh state, built before it and torn down after it", () => {
      const fake = harness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      run(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      const lifecycle = fake.log.filter((entry) => entry !== "now" && entry !== "collect");
      expect(fake.built.length).toBeGreaterThan(1);
      expect(lifecycle).toStrictEqual(
        fake.built.flatMap(({ id }) => [`setup ${id}`, `fn ${id}`, `teardown ${id}`]),
      );
    });

    it("reports the run's length, every setup and teardown in it included", () => {
      const fake = harness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      const result = run(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3 });

      expect(result.timingMs).toBe(38_400);
    });

    it("runs without a teardown", () => {
      const fake = harness({ bodyMs: () => 200 });

      const result = samplePerCall({
        now: fake.now,
        resolutionMs: FINE_RESOLUTION,
        setup: fake.setup,
        fn: fake.fn,
        collect: fake.collect,
        minTime: 1000,
        minSamples: 64,
      });

      expect(result.sampleCount).toBe(64);
    });
  });

  describe("stopping rule", () => {
    describe("when samples are long", () => {
      it("runs 16 warmup samples", () => {
        const fake = harness({ bodyMs: () => 200 });

        run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([16]);
      });

      it("reports warmup's samples, leaving out the forced GC's call", () => {
        const fake = harness({ bodyMs: () => 200 });

        const result = run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.warmupSamples).toBe(16);
      });

      it("runs 64 timed samples", () => {
        const fake = harness({ bodyMs: () => 200 });

        const result = run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.sampleCount).toBe(64);
        expect(fake.sampleCalls).toHaveLength(80);
      });
    });

    describe("when setup and teardown time dominates each sample's wall time", () => {
      it("runs warmup samples until 3000 ms of wall time have passed", () => {
        const fake = harness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([273]);
      });

      it("runs timed samples until 1000 ms of wall time have passed", () => {
        const fake = harness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        const result = run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(result.sampleCount).toBe(91);
      });
    });

    describe("when samples are short", () => {
      it("stops warmup at 1000 samples", () => {
        const fake = harness({ bodyMs: (_sample, timed) => (timed ? 0.25 : 1) });

        run(fake, { resolutionMs: FINE_RESOLUTION });

        expect(fake.collectsAt).toStrictEqual([1000]);
      });

      it.each([
        { count: "a calibrated", callsPerSample: undefined },
        { count: "a fixed", callsPerSample: 1 },
      ])(
        "stops timing $count count at the store's size, `time` in samples of 200 times the resolution, rounded up, plus `samples`",
        ({ callsPerSample }) => {
          const fake = harness({ bodyMs: (_sample, timed) => (timed ? 0.125 : 1) });

          const result = run(fake, {
            resolutionMs: FINE_RESOLUTION,
            callsPerSample,
            minTime: 100.1,
            minSamples: 10,
          });

          expect(result.spans).toBeInstanceOf(Float64Array);
          expect(result.spans).toHaveLength(523);
          expect(result.sampleCount).toBe(523);
        },
      );
    });
  });

  describe("calls per sample", () => {
    it("runs every timed sample at the count warmup ended on", () => {
      const fake = harness({
        bodyMs: (_sample, timed) => (timed ? 0 : 3 * COARSE_RESOLUTION),
        buildMs: 0.25,
      });

      const result = run(fake, { resolutionMs: COARSE_RESOLUTION });

      const timedCalls = fake.sampleCalls.slice(fake.collectsAt[0]);
      expect(timedCalls).toHaveLength(result.sampleCount);
      expect(new Set(timedCalls)).toStrictEqual(new Set([67]));
      expect(result.callsPerSample).toBe(67);
    });

    describe("when the count would exceed 200 times the resolution of a 0.1 ns body", () => {
      /**
       * Reads no clock change per sample, so warmup asks for 1, 100, then 10000 calls; the body throws on
       * its first call past those 101 so a sampler that runs the over-cap count stops, not hangs.
       */
      const zeroStepBody: Costs = { bodyMs: () => 0, throwAt: 101 };

      it("fails naming the count asked for and the cap", () => {
        const fake = harness(zeroStepBody);

        const error = errorOf(() => run(fake, { resolutionMs: CAPPED_STEP }));

        expect(error.message).toMatch(/\b10000\b/);
        expect(error.message).toMatch(/\b1908\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(zeroStepBody);

        errorOf(() => run(fake, { resolutionMs: CAPPED_STEP }));

        expect(fake.sampleCalls).toStrictEqual([1, 100]);
        expect(fake.built).toHaveLength(101);
      });
    });

    describe("when given a fixed count", () => {
      it("runs every warmup and timed sample at that count", () => {
        const fake = harness({ bodyMs: () => COARSE_RESOLUTION, buildMs: 1 });

        const result = run(fake, { resolutionMs: COARSE_RESOLUTION, callsPerSample: 7 });

        expect(new Set(fake.sampleCalls)).toStrictEqual(new Set([7]));
        expect(fake.sampleCalls.length).toBeGreaterThan(16 + 64);
        expect(result.callsPerSample).toBe(7);
      });

      it("runs a count above the cap", () => {
        const fake = harness({ bodyMs: () => 0.1 });

        const result = run(fake, { resolutionMs: CAPPED_STEP, callsPerSample: 2000 });

        expect(result.callsPerSample).toBe(2000);
      });
    });
  });

  describe("collection", () => {
    it("runs the body outside any clock read on a state of its own, collecting before tearing it down", () => {
      const fake = harness({ bodyMs: () => 200 });

      run(fake, { resolutionMs: FINE_RESOLUTION });

      const at = fake.log.indexOf("collect");
      const id = fake.built[16]?.id;
      expect(fake.log.slice(at - 2, at + 2)).toStrictEqual([
        `setup ${id}`,
        `fn ${id}`,
        "collect",
        `teardown ${id}`,
      ]);
    });
  });

  describe("states reachable for cleanup", () => {
    it.each([
      { when: "the body throws mid-sample", throwAt: 4, samplesBefore: 1, liveCount: 1 },
      {
        when: "the body throws during the forced GC's run",
        throwAt: 48,
        samplesBefore: 16,
        liveCount: 1,
      },
      { when: "a teardown throws mid-sample", teardownThrowAt: 4, samplesBefore: 1, liveCount: 1 },
      { when: "the forced GC throws", collectThrows: true, samplesBefore: 16, liveCount: 1 },
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
        const fake = harness({ bodyMs: () => 200, ...throws });
        const slots: (World | undefined)[] = [];

        expect(() =>
          run(fake, { resolutionMs: FINE_RESOLUTION, callsPerSample: 3, slots }),
        ).toThrow(fake.failure);

        expect(fake.sampleCalls).toHaveLength(samplesBefore);
        expect(fake.live.size).toBe(liveCount);
        expect(slots.filter((slot) => slot !== undefined)).toStrictEqual([...fake.live]);
      },
    );
  });

  describe("when given no clock or resolution", () => {
    it("times on performance.now", { timeout: 15_000 }, () => {
      let collections = 0;
      let calls = 0;

      const result = samplePerCall({
        setup: () => ({ total: 0 }),
        fn: (world: { total: number }) => {
          world.total += 1;
          calls += 1;
        },
        collect: () => {
          collections += 1;
        },
        minTime: 1000,
        minSamples: 64,
      });

      expect(collections).toBe(1);
      expect(result.sampleCount).toBeGreaterThanOrEqual(64);
      expect(calls).toBeGreaterThan(result.sampleCount * result.callsPerSample);
    });
  });
});
