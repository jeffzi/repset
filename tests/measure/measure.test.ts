import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  type Case,
  measure,
  MeasureError,
  type NoInline,
  summarize,
} from "../../src/measure/measure.js";
import { CalibrationError, cappedCount } from "../../src/measure/sampler.js";
import { errorOf } from "../error-of.js";
import { requiresRealBunHere } from "../real-bun.js";
import { temporaryDir } from "../temporary-dir.js";
import { exposedGc } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Scripted clocks and benchmark builders
// ---------------------------------------------------------------------------

const KINDS = ["sharedState", "perCall"] as const;
type Kind = (typeof KINDS)[number];

/** The resolution of the scripted clock, in milliseconds. */
const STEP_MS = 0.125;

interface SteppedClock {
  readonly now: () => number;
  /** Moves the clock on by `ms`, as a call outside the clock does, ending the run of reads. */
  readonly advance: (ms: number) => void;
}

/**
 * Builds a scripted clock that starts at 1000 ms: a read that directly follows another read finds
 * it `resolutionMs(reads)` on, where `reads` counts the reads since the last advance, this one included.
 *
 * @param resolutionMs - How far a read that follows another moves the clock, in milliseconds.
 * @returns The clock's read and its advance.
 */
function steppedClock(resolutionMs: (reads: number) => number = () => STEP_MS): SteppedClock {
  let time = 1000;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      if (reads > 1) time += resolutionMs(reads);
      return time;
    },
    advance: (ms) => {
      reads = 0;
      time += ms;
    },
  };
}

interface World {
  readonly id: number;
}

/** The call, counted from zero per callback, at which each callback throws. */
interface Failures {
  readonly setup?: number;
  readonly fn?: number;
  readonly teardown?: number;
}

interface BenchOptions {
  readonly bodyMs?: number;
  readonly fails?: Failures;
  readonly returns?: () => unknown;
  readonly teardownThrows?: unknown;
}

interface Bench {
  readonly benchmark: Case<World>;
  readonly now: () => number;
  readonly log: string[];
  readonly live: Set<World>;
  readonly noInline: NoInline;
  readonly inlined: unknown[];
  readonly setupError: Error;
  readonly fnError: string;
  readonly teardownError: unknown;
}

/**
 * Builds a benchmark on a scripted clock: setup, fn and teardown log themselves, the body charges
 * `bodyMs` per call, and a clock read that directly follows another read finds the clock one resolution on.
 * Stubs `globalThis.gc` with a no-op.
 *
 * @param kind - The benchmark's lifecycle.
 * @param options - The body's cost per call, which calls throw, what the body returns, and the
 *   value the teardown throws.
 * @returns The benchmark, its scripted clock, and the logs the tests read.
 */
function bench(kind: Kind, options: BenchOptions = {}): Bench {
  const { bodyMs = 100, fails = {}, returns = () => undefined } = options;
  const clock = steppedClock();
  let builds = 0;
  let bodies = 0;
  let teardownCalls = 0;
  const log: string[] = [];
  const live = new Set<World>();
  const inlined: unknown[] = [];
  const setupError = new Error("banana");
  const fnError = "apple";
  const teardownError = "teardownThrows" in options ? options.teardownThrows : { name: "cherry" };
  const benchmark: Case<World> = {
    kind,
    setup: () => {
      clock.advance(0);
      const id = builds;
      builds += 1;
      if (id === fails.setup) {
        throw setupError;
      }
      const world: World = { id };
      live.add(world);
      log.push(`setup ${world.id}`);
      return world;
    },
    fn: (world) => {
      clock.advance(0);
      log.push(`fn ${world.id}`);
      const call = bodies;
      bodies += 1;
      if (call === fails.fn) {
        // oxlint-disable-next-line typescript/only-throw-error -- measure must rethrow a non-Error value unchanged
        throw fnError;
      }
      clock.advance(bodyMs);
      return returns();
    },
    teardown: (world) => {
      clock.advance(0);
      const call = teardownCalls;
      teardownCalls += 1;
      if (call === fails.teardown) {
        // oxlint-disable-next-line typescript/only-throw-error -- measure must rethrow a non-Error value unchanged
        throw teardownError;
      }
      live.delete(world);
      log.push(`teardown ${world.id}`);
    },
  };
  vi.stubGlobal("gc", () => undefined);
  return {
    benchmark,
    now: clock.now,
    log,
    live,
    noInline: (fn) => {
      inlined.push(fn);
    },
    inlined,
    setupError,
    fnError,
    teardownError,
  };
}

/** Measures a benchmark on its scripted clock at a fixed count of one call per sample. */
function run(fake: Bench): ReturnType<typeof measure> {
  return measure(fake.benchmark, { now: fake.now, callsPerSample: 1, noInline: fake.noInline });
}

/**
 * Measures a per-call benchmark whose setup returns `undefined`, as `run` does: the fake's
 * callbacks still run and log, its world kept aside instead of passed as the state.
 *
 * @param fake - The benchmark whose callbacks the case calls.
 * @returns What `measure` returns.
 * @throws Error when the fake has no teardown, or a body or teardown call finds no world built.
 */
function runOnUndefined(fake: Bench): ReturnType<typeof measure> {
  const { setup, fn, teardown } = fake.benchmark;
  if (teardown === undefined) throw new Error("the fake has no teardown");
  let world: World | undefined;
  const built = (): World => {
    if (world === undefined) throw new Error("no world built");
    return world;
  };
  const benchmark: Case<undefined> = {
    kind: "perCall",
    setup: () => {
      world = setup();
      return undefined;
    },
    fn: () => fn(built()),
    teardown: () => {
      teardown(built());
    },
  };
  return measure(benchmark, { now: fake.now, callsPerSample: 1, noInline: fake.noInline });
}

/** The log entries naming a body call. */
function bodyCalls(log: readonly string[]): string[] {
  return log.filter((entry) => entry.startsWith("fn"));
}

/** The `MeasureError` a run rejects with, failing the test when it resolves or rejects otherwise. */
async function failure(outcome: Promise<unknown>): Promise<MeasureError> {
  const reason = await outcome.then(
    () => new Error("measure resolved"),
    (error: unknown) => error,
  );
  if (reason instanceof MeasureError) {
    return reason;
  }
  throw new Error("measure did not reject with a MeasureError", { cause: reason });
}

interface Scripted {
  readonly benchmark: Case<number>;
  readonly now: () => number;
}

/**
 * Builds a shared-state benchmark whose first timing attempt is discarded, on a scripted clock that
 * counts measure's collections from the body's first call.
 *
 * The body costs 800 times the resolution a call in warmup, so warmup settles on one call per sample; 150 times the resolution
 * in the first timing attempt, under the 200 times the resolution a kept run's median needs; and 300 times the resolution from the second
 * run on. From the second run's collection on, a clock read that directly follows another read
 * finds the clock 200 times the resolution on, so the empty body settles on one call per sample at 200 times the resolution,
 * under the body's cost divided by 1.42. Stubs `globalThis.gc` with the counter.
 *
 * @param onBody - Called on every body call with the collections counted so far.
 * @returns The benchmark and its scripted clock.
 */
function fasterAfterWarmup(onBody: (collections: number) => void = () => undefined): Scripted {
  const costSteps = [800, 150];
  let calls = 0;
  let collections = 0;
  const clock = steppedClock(() => (collections < 2 ? 1 : 200) * STEP_MS);
  vi.stubGlobal("gc", () => {
    if (calls > 0) collections += 1;
  });
  return {
    benchmark: {
      kind: "sharedState",
      setup: () => 0,
      fn: () => {
        calls += 1;
        onBody(collections);
        clock.advance((costSteps[collections] ?? 300) * STEP_MS);
      },
    },
    now: clock.now,
  };
}

/**
 * Builds a shared-state benchmark whose body costs 200 times the resolution a call in warmup, settling on one call
 * per sample, then half as much per call in each timing attempt as in the one before, so every timing
 * run's samples span 100 times the resolution and the third run is discarded too. Stubs `globalThis.gc` with the
 * counter of collections from the body's first call.
 *
 * @returns The benchmark and its scripted clock.
 */
function fasterEveryRun(): Scripted {
  let calls = 0;
  let collections = 0;
  const clock = steppedClock();
  vi.stubGlobal("gc", () => {
    if (calls > 0) collections += 1;
  });
  return {
    benchmark: {
      kind: "sharedState",
      setup: () => 0,
      fn: () => {
        calls += 1;
        clock.advance((200 / 2 ** collections) * STEP_MS);
      },
    },
    now: clock.now,
  };
}

/**
 * Builds a shared-state benchmark whose body costs 80 times the resolution a call, on a scripted
 * clock where a read that directly follows another read finds the clock 8 times the resolution on
 * for the first 250 ms after the body's last call, and one resolution on otherwise: the empty body
 * reads slow at first, as it does when the engine compiles its loop partway through. Stubs
 * `globalThis.gc` with a no-op.
 *
 * @returns The benchmark and its scripted clock.
 */
function emptyBodyFasterAfter250Ms(): Scripted {
  let time = 1000;
  let followsRead = false;
  let lastBodyMs: number | undefined;
  vi.stubGlobal("gc", () => undefined);
  return {
    benchmark: {
      kind: "sharedState",
      setup: () => 0,
      fn: () => {
        time += 80 * STEP_MS;
        lastBodyMs = time;
        followsRead = false;
      },
    },
    now: () => {
      if (followsRead) {
        const slow = lastBodyMs !== undefined && time - lastBodyMs < 250;
        time += (slow ? 8 : 1) * STEP_MS;
      }
      followsRead = true;
      return time;
    },
  };
}

// ---------------------------------------------------------------------------
// measure, in process
// ---------------------------------------------------------------------------

describe("measure", () => {
  describe("on a shared-state benchmark", () => {
    it("builds one state", async () => {
      const fake = bench("sharedState");

      await run(fake);

      expect(fake.log.filter((entry) => entry.startsWith("setup"))).toStrictEqual(["setup 0"]);
    });

    it("tears its one state down once", async () => {
      const fake = bench("sharedState");

      await run(fake);

      expect(fake.log.filter((entry) => entry.startsWith("teardown"))).toStrictEqual([
        "teardown 0",
      ]);
    });
  });

  describe("when no gc is exposed", () => {
    it("rejects a benchmark in phase child", async () => {
      const fake = bench("sharedState");
      vi.stubGlobal("gc", undefined);

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
    });
  });

  describe("when its body returns an object with a then property", () => {
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
    const thenable = (): unknown => ({ then: () => 0 });

    it.each(KINDS)(
      "fails a %s run whose body returns an object with a then method on its first call in phase fn",
      async (kind) => {
        const fake = bench(kind, { returns: thenable });

        const error = await failure(run(fake));

        expect(error.phase).toBe("fn");
        expect(bodyCalls(fake.log)).toHaveLength(1);
      },
    );

    it("accepts a body returning an object whose then is not a function", async () => {
      // oxlint-disable-next-line unicorn/no-thenable -- a `then` that is not a function is the input under test
      const fake = bench("sharedState", { returns: () => ({ then: "banana" }) });

      const result = await run(fake);

      expect(result.sampleCount).toBe(64);
    });
  });

  describe("when a callback or the collector throws", () => {
    // One call per sample of 200 ms on both kinds. Body call 0 is the synchronous-body check and
    // calls 1-16 warm up; setup and teardown calls count the same way.
    const BUILD_OR_BODY_FAILURES = [
      { kind: "sharedState", when: "the setup throws", fails: { setup: 0 }, from: "setup" },
      {
        kind: "sharedState",
        when: "the check's body call throws",
        fails: { fn: 0 },
        from: "fn",
      },
      { kind: "perCall", when: "the check's setup throws", fails: { setup: 0 }, from: "setup" },
      { kind: "perCall", when: "the check's body call throws", fails: { fn: 0 }, from: "fn" },
      { kind: "perCall", when: "the body throws in warmup", fails: { fn: 5 }, from: "fn" },
    ] as const;

    it.each(BUILD_OR_BODY_FAILURES)(
      "rejects a $kind run in phase $from with the thrown value itself as cause when $when",
      async ({ kind, fails, from }) => {
        const fake = bench(kind, { bodyMs: 200, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe(from);
        expect(error.cause).toBe(from === "setup" ? fake.setupError : fake.fnError);
      },
    );

    it.each(BUILD_OR_BODY_FAILURES.filter((row) => row.from !== "setup"))(
      "tears down every state a $kind run built when $when",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: 200, fails });

        await run(fake).catch(() => undefined);

        expect(fake.live.size).toBe(0);
        expect(fake.log.filter((entry) => entry.startsWith("teardown"))).toHaveLength(
          fake.log.filter((entry) => entry.startsWith("setup")).length,
        );
      },
    );

    it.each([
      { kind: "sharedState", when: "the one teardown throws", fails: { teardown: 0 } },
      { kind: "perCall", when: "the check's teardown throws", fails: { teardown: 0 } },
      { kind: "perCall", when: "a warmup teardown throws", fails: { teardown: 2 } },
    ] as const)(
      "rejects a $kind run whose body succeeded in phase teardown with the teardown's value as cause when $when",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: 200, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe("teardown");
        expect(error.cause).toBe(fake.teardownError);
      },
    );

    // Teardown call n releases state n, and a teardown call that does not throw drops its state
    // from the live set: a second teardown of the state that threw would drop it too.
    it("leaves alive only the state whose teardown threw", async () => {
      const fails = { teardown: 2 };
      const fake = bench("perCall", { bodyMs: 200, fails });

      await run(fake).catch(() => undefined);

      expect([...fake.live].map((world) => world.id)).toStrictEqual([fails.teardown]);
    });

    it("rejects a per-call run whose setup returns undefined in phase fn when the body throws in warmup", async () => {
      const fake = bench("perCall", { bodyMs: 200, fails: { fn: 5 } });

      const error = await failure(runOnUndefined(fake));

      expect(error.phase).toBe("fn");
    });

    it("tears down every state a per-call run whose setup returns undefined built when the body throws in warmup", async () => {
      const fake = bench("perCall", { bodyMs: 200, fails: { fn: 5 } });

      await runOnUndefined(fake).catch(() => undefined);

      expect(fake.live.size).toBe(0);
    });

    const BODY_AND_CLEANUP_FAILURES = [
      { kind: "sharedState", fails: { fn: 5, teardown: 0 } },
      { kind: "perCall", fails: { fn: 5, teardown: 5 } },
    ] as const;

    it.each(BODY_AND_CLEANUP_FAILURES)(
      "rejects a $kind run in phase fn with the body's value as cause when the cleanup's teardown throws too",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: 200, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe("fn");
        expect(error.cause).toBe(fake.fnError);
      },
    );

    it.each(BODY_AND_CLEANUP_FAILURES)(
      "keeps the cleanup's teardown failure on a $kind run's error in phase teardown, the teardown's value as cause, when the body throws first",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: 200, fails });

        const error = await failure(run(fake));

        expect(error.teardownError).toBeInstanceOf(MeasureError);
        expect(error.teardownError?.phase).toBe("teardown");
        expect(error.teardownError?.cause).toBe(fake.teardownError);
      },
    );

    it("keeps a cleanup teardown that throws null on the body's error, null as cause", async () => {
      const fake = bench("perCall", {
        bodyMs: 200,
        fails: { fn: 5, teardown: 5 },
        teardownThrows: null,
      });

      const error = await failure(run(fake));

      expect(error.teardownError).toBeInstanceOf(MeasureError);
      expect(error.teardownError?.cause).toBeNull();
    });

    it("keeps the cleanup's teardown failure on a shared-state run whose collection throws, the collector's value as cause", async () => {
      const fake = bench("sharedState", { bodyMs: 200, fails: { teardown: 0 } });
      const collectorError = new Error("durian");
      vi.stubGlobal("gc", () => {
        throw collectorError;
      });

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
      expect(error.cause).toBe(collectorError);
      expect(error.teardownError?.phase).toBe("teardown");
      expect(error.teardownError?.cause).toBe(fake.teardownError);
    });

    it("rejects a shared-state run with no teardown failure kept when the body throws and the cleanup's teardown succeeds", async () => {
      const fake = bench("sharedState", { bodyMs: 200, fails: { fn: 5 } });

      const error = await failure(run(fake));

      expect(error.teardownError).toBeNull();
    });

    it.each(KINDS)(
      "rejects a %s run whose collection throws in phase child with the collector's value as cause",
      async (kind) => {
        const fake = bench(kind, { bodyMs: 200 });
        const collectorError = new Error("durian");
        vi.stubGlobal("gc", () => {
          throw collectorError;
        });

        const error = await failure(run(fake));

        expect(error.phase).toBe("child");
        expect(error.cause).toBe(collectorError);
      },
    );

    it.each(KINDS)(
      "rejects a %s run whose body throws an Error worded as the cap's in phase fn",
      async (kind) => {
        const own = new Error(errorOf(() => cappedCount(1000, 0, 2 ** -16)).message);
        const clock = steppedClock();
        let calls = 0;
        vi.stubGlobal("gc", () => undefined);
        const benchmark: Case<number> = {
          kind,
          setup: () => 0,
          fn: () => {
            calls += 1;
            if (calls > 5) throw own;
            clock.advance(200);
          },
        };

        const error = await failure(measure(benchmark, { now: clock.now }));

        expect(error.phase).toBe("fn");
        expect(error.cause).toBe(own);
      },
    );

    it("rejects a shared-state run whose third timing attempt is discarded too in phase calibration", async () => {
      const fake = fasterEveryRun();

      const error = await failure(measure(fake.benchmark, { now: fake.now }));

      expect(error.phase).toBe("calibration");
      expect(error.cause).toBeInstanceOf(CalibrationError);
    });

    // a clock whose resolution is 1e-9 ms puts the cap at two calls per sample, and a body that moves the clock
    // by nothing spans no clock change, so warmup's first sample asks for 100 calls.
    it("rejects a per-call run whose warmup count passes the cap in phase calibration, the sampler's error as cause", async () => {
      const clock = steppedClock(() => 1e-9);
      vi.stubGlobal("gc", () => undefined);
      const benchmark: Case<number> = {
        kind: "perCall",
        setup: () => 0,
        fn: () => {
          clock.advance(0);
        },
      };

      const error = await failure(measure(benchmark, { now: clock.now }));

      expect(error.phase).toBe("calibration");
      expect(error.cause).toBeInstanceOf(CalibrationError);
    });

    it("rejects a run whose empty body's collection throws in phase child, the collector's value as cause", async () => {
      const fake = bench("perCall", { bodyMs: 200 });
      const collectorError = new Error("durian");
      let collections = 0;
      vi.stubGlobal("gc", () => {
        collections += 1;
        if (collections > 1) throw collectorError;
      });

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
      expect(error.cause).toBe(collectorError);
    });
  });

  describe("when given a noInline", () => {
    it("hands an injected noInline the body itself", async () => {
      const fake = bench("sharedState", { bodyMs: 200 });

      await run(fake);

      expect(fake.inlined).toContain(fake.benchmark.fn);
    });
  });

  describe("when comparing the body with the empty body", () => {
    // The empty body spans one resolution per sample, 125000 ns per call at one call per sample.
    it("fails a run whose body costs under 1.42 times the empty body in phase optimized-away, naming both readings", async () => {
      const fake = bench("sharedState", { bodyMs: 1.375 * STEP_MS });

      const error = await failure(run(fake));

      expect(error.phase).toBe("optimized-away");
      expect(error.message).toMatch(/171875[^]*125000|125000[^]*171875/);
    });

    it("returns the ratio of the body's mean to the empty body's at 1.4375", async () => {
      const fake = bench("sharedState", { bodyMs: 1.4375 * STEP_MS });

      const result = await run(fake);

      expect(result.ratioToEmptyBody).toBeCloseTo(1.4375, 6);
    });

    it("fails a shared-state run whose empty body asks for more calls per sample than the cap in phase calibration", async () => {
      const fake = bench("sharedState");

      const error = await failure(
        measure(fake.benchmark, { now: fake.now, noInline: fake.noInline }),
      );

      expect(error.phase).toBe("calibration");
    });

    it("returns the ratio to the empty body as it reads once 250 ms of the empty body's warmup have passed", async () => {
      const scripted = emptyBodyFasterAfter250Ms();

      const result = await measure(scripted.benchmark, { now: scripted.now, callsPerSample: 1 });

      expect(result.ratioToEmptyBody).toBe(80);
    });

    // Two calls per sample: summed per-call spans read one resolution per empty call, a batched pair of
    // clock reads one resolution per two calls.
    it("times a per-call run's empty body as summed per-call spans", async () => {
      const fake = bench("perCall");

      const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

      expect(result.ratioToEmptyBody).toBeCloseTo(800, 6);
    });
  });

  describe("when given minTime and minSamples", () => {
    it("times a body until both given have passed", async () => {
      const fake = bench("sharedState");

      const result = await measure(fake.benchmark, {
        now: fake.now,
        callsPerSample: 1,
        noInline: fake.noInline,
        minTime: 2950,
        minSamples: 10,
      });

      expect(result.sampleCount).toBe(30);
    });
  });

  describe("when it returns a result", () => {
    it("returns the timed statistics with the resolution, the fixed count, the forced GC and the ratio to the empty body", async () => {
      const fake = bench("sharedState");

      const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

      expect(result).toStrictEqual({
        min: 100_000_000,
        p25: 100_000_000,
        median: 100_000_000,
        p75: 100_000_000,
        p99: 100_000_000,
        max: 100_000_000,
        mean: 100_000_000,
        sampleCount: 64,
        timerResolutionNs: 125_000,
        callsPerSample: 2,
        callsPerSampleFixed: true,
        ratioToEmptyBody: 1600,
        gcDuringTiming: expect.any(Object),
        timingAttempts: 1,
        warmupSamples: 16,
        timingMs: expect.any(Number),
      });
    });

    it("reports a count it settled itself as not fixed", async () => {
      const fake = fasterAfterWarmup();

      const result = await measure(fake.benchmark, { now: fake.now });

      expect(result.callsPerSampleFixed).toBe(false);
    });
  });

  describe("when the body forces collections during timing", () => {
    it("reports the collections a body forces while timed, with their total and longest duration", async () => {
      const gc = exposedGc();
      const fake = bench("sharedState", { returns: gc });
      vi.stubGlobal("gc", gc);

      const result = await run(fake);

      const observed = result.gcDuringTiming;
      expect(observed?.major).toBeGreaterThanOrEqual(1);
      expect(observed?.maxMs).toBeGreaterThan(0);
      expect(observed?.totalMs).toBeGreaterThanOrEqual(observed?.maxMs ?? Number.NaN);
    });

    it("counts the minor collections a body forces while timed", async () => {
      const fake = bench("sharedState", { returns: exposedGc({ type: "minor" }) });

      const result = await run(fake);

      expect(result.gcDuringTiming?.minor).toBeGreaterThanOrEqual(1);
    });

    it("counts the forced GC a body forces during the kept timing attempt, leaving out those it forces during a discarded one", async () => {
      const gc = exposedGc();
      let forcedInKept = false;
      const fake = fasterAfterWarmup((collections) => {
        if (collections === 1) gc();
        if (collections === 2 && !forcedInKept) {
          forcedInKept = true;
          gc();
        }
      });

      const result = await measure(fake.benchmark, { now: fake.now });

      expect(result.gcDuringTiming?.count).toBe(1);
    });

    it("counts none for a body that allocates nothing, leaving out the forced GC before timing", async () => {
      const clock = steppedClock();
      vi.stubGlobal("gc", exposedGc());
      const benchmark: Case<number> = {
        kind: "sharedState",
        setup: () => 0,
        fn: () => {
          clock.advance(100);
        },
      };

      const result = await measure(benchmark, { now: clock.now, callsPerSample: 1 });

      expect(result.gcDuringTiming).toStrictEqual({
        count: 0,
        minor: 0,
        major: 0,
        totalMs: 0,
        maxMs: 0,
      });
    });
  });
});

describe("summarize", () => {
  describe("when the spans are stored ascending", () => {
    it("reports per-call nanoseconds with percentiles interpolated between ranks", () => {
      const spans = Float64Array.of(4, 8, 12, 16);

      const statistics = summarize(spans, 4, 4);

      expect(statistics).toStrictEqual({
        min: 1_000_000,
        p25: 1_750_000,
        median: 2_500_000,
        p75: 3_250_000,
        p99: expect.closeTo(3_970_000, 3),
        max: 4_000_000,
        mean: 2_500_000,
        sampleCount: 4,
      });
    });
  });

  describe("when the spans are stored out of order", () => {
    it("reports the same statistics as the ascending store", () => {
      const ascending = summarize(Float64Array.of(4, 8, 12, 16), 4, 4);

      const shuffled = summarize(Float64Array.of(12, 4, 16, 8), 4, 4);

      expect(shuffled).toStrictEqual(ascending);
    });
  });

  describe("when the store is only partly filled", () => {
    it("ignores the slots past the stored count", () => {
      const spans = new Float64Array(8);
      spans.set([2, 4, 6]);

      const statistics = summarize(spans, 3, 2);

      expect(statistics).toStrictEqual({
        min: 1_000_000,
        p25: 1_500_000,
        median: 2_000_000,
        p75: 2_500_000,
        p99: expect.closeTo(2_980_000, 3),
        max: 3_000_000,
        mean: 2_000_000,
        sampleCount: 3,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// measure under real Bun
// ---------------------------------------------------------------------------

const MEASURE_PATH = fileURLToPath(new URL("../../src/measure/measure.ts", import.meta.url));
const RUNTIME_PATH = fileURLToPath(new URL("../../src/measure/runtime.ts", import.meta.url));

/** Bun starting, then a few real-clock measurements of about 1.25 s each, on a slow CI runner. */
const BUN_TIMEOUT_MS = 60_000;

/** A cheap shared-state benchmark well above the empty body's cost, as script source. */
const SCRIPT_BENCH = `
const values = Array.from({ length: 64 }, (_, index) => index);
let sink = 0;
const setup = () => ({ values });
const fn = (world) => { for (const value of world.values) sink += value; };
`;

interface BunTestRun {
  readonly status: number | null;
  /** The JSON the test printed after `REPORT `, or `null` when it printed none. */
  readonly report: unknown;
}

/**
 * Runs `body` as one `bun test` case with `measure` and `MeasureError` imported, the benchmark of
 * {@link SCRIPT_BENCH} defined, a stub `gc`, a `loadFailure` object for a factory to throw, and
 * `bun:jsc` mocked by `bunJsc`: by default so that `received` holds every function its `noInline`
 * received.
 *
 * @param body - Statements of the async test case; one prints `REPORT ` followed by JSON.
 * @param bunJsc - The source of the factory `bun:jsc` is mocked with.
 * @returns How `bun test` exited and the parsed report.
 * @throws Error from the filesystem when the temporary directory or test file cannot be written.
 * @throws SyntaxError when the printed report is not valid JSON.
 */
function bunTestWithNoInlineMock(
  body: string,
  bunJsc = "() => ({ noInline: (fn) => { received.push(fn); } })",
): BunTestRun {
  const dir = temporaryDir("repset-bun-");
  const file = join(dir, "no-inline.test.ts");
  writeFileSync(
    file,
    `
import { mock, test } from "bun:test";
const received = [];
const loadFailure = { name: "durian" };
mock.module("bun:jsc", ${bunJsc});
globalThis.gc = () => {};
test("noInline", async () => {
  const { measure, MeasureError } = await import(${JSON.stringify(MEASURE_PATH)});
  ${SCRIPT_BENCH}
${body}
}, 50_000);
`,
  );

  const child = spawnSync("bun", ["test", file], { cwd: dir, encoding: "utf8" });

  const report = /REPORT (.*)/.exec(`${child.stdout}\n${child.stderr}`)?.[1];
  return { status: child.status, report: JSON.parse(report ?? "null") };
}

describe.runIf(requiresRealBunHere())("measure under real Bun", () => {
  it(
    "measures a shared-state benchmark with bun:jsc loaded, reporting no gc entries",
    () => {
      const script = `
const { measure } = await import(${JSON.stringify(MEASURE_PATH)});
const { runningRuntime } = await import(${JSON.stringify(RUNTIME_PATH)});
${SCRIPT_BENCH}
const result = await measure({ kind: "sharedState", setup, fn });
console.log(JSON.stringify({
  runtime: runningRuntime(),
  observesGc: "gcDuringTiming" in result,
  sampleCount: result.sampleCount,
  sank: sink > 0,
}));
`;

      const child = spawnSync("bun", ["--expose-gc", "-e", script], { encoding: "utf8" });

      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toStrictEqual({
        runtime: "bun",
        observesGc: false,
        sampleCount: expect.any(Number),
        sank: true,
      });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "hands bun:jsc's noInline the body itself",
    () => {
      const bun = bunTestWithNoInlineMock(`
  await measure({ kind: "sharedState", setup, fn });
  console.log("REPORT " + JSON.stringify({ fn: received.includes(fn) }));
`);

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ fn: true });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "leaves bun:jsc's noInline unused when one is injected",
    () => {
      const bun = bunTestWithNoInlineMock(`
  const injected = [];
  await measure({ kind: "sharedState", setup, fn }, { noInline: (fn) => { injected.push(fn); } });
  console.log("REPORT " + JSON.stringify({ bunJsc: received.length, injected: injected.length }));
`);

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ bunJsc: 0, injected: 2 });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "rejects in phase child with the loader's value as cause when bun:jsc cannot be loaded",
    () => {
      const bun = bunTestWithNoInlineMock(
        `
  const error = await measure({ kind: "sharedState", setup, fn }).then(() => null, (e) => e);
  console.log("REPORT " + JSON.stringify({
    measureError: error instanceof MeasureError,
    phase: error?.phase,
    cause: error?.cause === loadFailure,
  }));
`,
        "() => { throw loadFailure; }",
      );

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ measureError: true, phase: "child", cause: true });
    },
    BUN_TIMEOUT_MS,
  );
});
