import { describe, expect, it } from "vitest";

import { samplePerCall } from "../../src/measure/per-call.js";
import type { SamplerResult } from "../../src/measure/shared-context.js";
import { COARSE_STEP, FINE_STEP } from "./fixtures.js";

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
 * clock reads taken with no context alive.
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
  readonly stepMs: number;
  readonly callsPerSample?: number;
  readonly slots?: (World | undefined)[];
}

/** Runs the sampler on a harness, forwarding `callsPerSample` and `slots` only when set. */
function run(fake: Harness, options: RunOptions): SamplerResult {
  return samplePerCall({
    now: fake.now,
    stepMs: options.stepMs,
    setup: fake.setup,
    fn: fake.fn,
    teardown: fake.teardown,
    collect: fake.collect,
    ...(options.callsPerSample === undefined ? {} : { callsPerSample: options.callsPerSample }),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
  });
}

/** A timer step whose cap, `ceil(200 × step / 0.1 ns)`, is 1908 calls. */
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

      const result = run(fake, { stepMs: FINE_STEP, callsPerSample: 3 });

      expect(Array.from(result.spans.subarray(0, result.samples))).toStrictEqual(
        Array.from({ length: 64 }, () => 300),
      );
    });

    it("runs each body call on a fresh context, built before it and torn down after it", () => {
      const fake = harness({ bodyMs: () => 100, buildMs: 50, teardownMs: 50 });

      run(fake, { stepMs: FINE_STEP, callsPerSample: 3 });

      const lifecycle = fake.log.filter((entry) => entry !== "now" && entry !== "collect");
      expect(fake.built.length).toBeGreaterThan(1);
      expect(lifecycle).toStrictEqual(
        fake.built.flatMap(({ id }) => [`setup ${id}`, `fn ${id}`, `teardown ${id}`]),
      );
    });

    it("runs without a teardown", () => {
      const fake = harness({ bodyMs: () => 200 });

      const result = samplePerCall({
        now: fake.now,
        stepMs: FINE_STEP,
        setup: fake.setup,
        fn: fake.fn,
        collect: fake.collect,
      });

      expect(result.samples).toBe(64);
    });
  });

  describe("stopping rule", () => {
    describe("when samples are long", () => {
      it("runs 16 warmup samples", () => {
        const fake = harness({ bodyMs: () => 200 });

        run(fake, { stepMs: FINE_STEP });

        expect(fake.collectsAt).toStrictEqual([16]);
      });

      it("runs 64 timed samples", () => {
        const fake = harness({ bodyMs: () => 200 });

        const result = run(fake, { stepMs: FINE_STEP });

        expect(result.samples).toBe(64);
        expect(fake.sampleCalls).toHaveLength(80);
      });
    });

    describe("when setup and teardown time dominates each sample's wall time", () => {
      it("runs warmup samples until 3000 ms of wall time have passed", () => {
        const fake = harness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        run(fake, { stepMs: FINE_STEP });

        expect(fake.collectsAt).toStrictEqual([273]);
      });

      it("runs timed samples until 1000 ms of wall time have passed", () => {
        const fake = harness({ bodyMs: () => 1, buildMs: 6, teardownMs: 4 });

        const result = run(fake, { stepMs: FINE_STEP });

        expect(result.samples).toBe(91);
      });
    });

    describe("when samples are short", () => {
      it("stops warmup at 1000 samples", () => {
        const fake = harness({ bodyMs: (_sample, timed) => (timed ? 0.25 : 1) });

        run(fake, { stepMs: FINE_STEP });

        expect(fake.collectsAt).toStrictEqual([1000]);
      });

      it("stops timing at 2000 samples, the store's size", () => {
        const fake = harness({ bodyMs: (_sample, timed) => (timed ? 0.25 : 1) });

        const result = run(fake, { stepMs: FINE_STEP });

        expect(result.spans).toBeInstanceOf(Float64Array);
        expect(result.spans).toHaveLength(2000);
        expect(result.samples).toBe(2000);
      });
    });
  });

  describe("calls per sample", () => {
    it("runs every timed sample at the count warmup ended on", () => {
      const fake = harness({
        bodyMs: (_sample, timed) => (timed ? 0 : 3 * COARSE_STEP),
        buildMs: 0.25,
      });

      const result = run(fake, { stepMs: COARSE_STEP });

      const timedCalls = fake.sampleCalls.slice(fake.collectsAt[0]);
      expect(timedCalls).toHaveLength(result.samples);
      expect(new Set(timedCalls)).toStrictEqual(new Set([67]));
      expect(result.callsPerSample).toBe(67);
    });

    describe("when the count would exceed 200 steps of a 0.1 ns body", () => {
      /**
       * Reads no step per sample, so warmup asks for 1, 100, then 10000 calls; the body throws on
       * its first call past those 101 so a sampler that runs the over-cap count stops, not hangs.
       */
      const zeroStepBody: Costs = { bodyMs: () => 0, throwAt: 101 };

      it("fails naming the count asked for and the cap", () => {
        const fake = harness(zeroStepBody);

        const error = errorOf(() => run(fake, { stepMs: CAPPED_STEP }));

        expect(error.message).toMatch(/\b10000\b/);
        expect(error.message).toMatch(/\b1908\b/);
      });

      it("fails before any sample runs that count", () => {
        const fake = harness(zeroStepBody);

        errorOf(() => run(fake, { stepMs: CAPPED_STEP }));

        expect(fake.sampleCalls).toStrictEqual([1, 100]);
        expect(fake.built).toHaveLength(101);
      });
    });

    describe("when given a fixed count", () => {
      it("runs every warmup and timed sample at that count", () => {
        const fake = harness({ bodyMs: () => COARSE_STEP, buildMs: 1 });

        const result = run(fake, { stepMs: COARSE_STEP, callsPerSample: 7 });

        expect(new Set(fake.sampleCalls)).toStrictEqual(new Set([7]));
        expect(fake.sampleCalls.length).toBeGreaterThan(16 + 64);
        expect(result.callsPerSample).toBe(7);
      });

      it("runs a count above the cap", () => {
        const fake = harness({ bodyMs: () => 0.1 });

        const result = run(fake, { stepMs: CAPPED_STEP, callsPerSample: 2000 });

        expect(result.callsPerSample).toBe(2000);
      });
    });
  });

  describe("collection", () => {
    it("runs the body outside any clock read on a context of its own, collecting before tearing it down", () => {
      const fake = harness({ bodyMs: () => 200 });

      run(fake, { stepMs: FINE_STEP });

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

  describe("contexts reachable for cleanup", () => {
    it.each([
      { when: "the body throws mid-sample", throwAt: 4, samplesBefore: 1, liveCount: 1 },
      {
        when: "the body throws during the collection's run",
        throwAt: 48,
        samplesBefore: 16,
        liveCount: 1,
      },
      { when: "a teardown throws mid-sample", teardownThrowAt: 4, samplesBefore: 1, liveCount: 1 },
      { when: "the collection throws", collectThrows: true, samplesBefore: 16, liveCount: 1 },
      {
        when: "the collection's teardown throws",
        teardownThrowAt: 48,
        samplesBefore: 16,
        liveCount: 1,
      },
      { when: "a setup throws mid-sample", setupThrowAt: 4, samplesBefore: 1, liveCount: 0 },
    ])(
      "leaves the caller exactly the contexts built and not torn down when $when",
      ({ samplesBefore, liveCount, ...throws }) => {
        const fake = harness({ bodyMs: () => 200, ...throws });
        const slots: (World | undefined)[] = [];

        expect(() => run(fake, { stepMs: FINE_STEP, callsPerSample: 3, slots })).toThrow(
          fake.failure,
        );

        expect(fake.sampleCalls).toHaveLength(samplesBefore);
        expect(fake.live.size).toBe(liveCount);
        expect(slots.filter((slot) => slot !== undefined)).toStrictEqual([...fake.live]);
      },
    );
  });

  describe("when given no clock or step", () => {
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
      });

      expect(collections).toBe(1);
      expect(result.samples).toBeGreaterThanOrEqual(64);
      expect(calls).toBeGreaterThan(result.samples * result.callsPerSample);
    });
  });
});
