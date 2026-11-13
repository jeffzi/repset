import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { runningEngine } from "../../src/measure/engine.js";
import { type Case, measure, MeasureError, type NoInline } from "../../src/measure/measure.js";
import { BudgetError, cappedCount } from "../../src/measure/shared-context.js";
import { requiresRealBunHere } from "../real-bun.js";

const KINDS = ["sharedContext", "perCall"] as const;
type Kind = (typeof KINDS)[number];

/** The step of the scripted clock, in milliseconds. */
const STEP_MS = 0.125;

interface SteppedClock {
  readonly now: () => number;
  /** Moves the clock on by `ms`, as a call outside the clock does, ending the run of reads. */
  readonly advance: (ms: number) => void;
}

/**
 * Builds a scripted clock that starts at 1000 ms: a read that directly follows another read finds
 * it `stepMs(reads)` on, where `reads` counts the reads since the last advance, this one included.
 *
 * @param stepMs - How far a read that follows another moves the clock, in milliseconds.
 * @returns The clock's read and its advance.
 */
function steppedClock(stepMs: (reads: number) => number = () => STEP_MS): SteppedClock {
  let time = 1000;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      if (reads > 1) time += stepMs(reads);
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
  readonly teardown?: boolean;
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
  readonly teardownError: { readonly name: string };
}

/**
 * Builds a benchmark on a scripted clock: setup, fn and teardown log themselves, the body charges
 * `bodyMs` per call, and a clock read that directly follows another read finds the clock one step on.
 * Stubs `globalThis.gc` with a recorder.
 *
 * @param kind - The benchmark's lifecycle.
 * @param options - The body's cost per call, which calls throw, and what the body returns.
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
  const teardownError = { name: "cherry" };
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
    ...(options.teardown === false
      ? {}
      : {
          teardown: (world: World) => {
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
        }),
  };
  vi.stubGlobal("gc", () => {
    log.push("gc");
  });
  return {
    benchmark,
    now: clock.now,
    log,
    live,
    noInline: (fn) => {
      inlined.push(fn);
      log.push("noInline");
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

/** The message the samplers' cap gives a count past it. */
function capMessage(): string {
  try {
    cappedCount(1000, 0, 2 ** -16);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  throw new Error("cappedCount refused no count with an Error");
}

interface Scripted {
  readonly benchmark: Case<number>;
  readonly now: () => number;
}

/**
 * Builds a shared-context benchmark whose first timing run is discarded, on a scripted clock that
 * counts measure's collections from the body's first call.
 *
 * The body costs 800 steps a call in warmup, so warmup settles on one call per sample; 150 steps
 * in the first timing run, under the 200 a kept run's median needs; and 300 steps from the second
 * run on. From the second run's collection on, a clock read that directly follows another read
 * finds the clock 200 steps on, so the empty body settles on one call per sample at 200 steps,
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
      kind: "sharedContext",
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
 * Builds a shared-context benchmark whose body costs 200 steps a call in warmup, settling on one call
 * per sample, then half as much per call in each timing run as in the one before, so every timing
 * run's samples span 100 steps and the third run is discarded too. Stubs `globalThis.gc` with the
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
      kind: "sharedContext",
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
 * Builds a benchmark whose body costs 100 ms a call, on a scripted clock that moves one step on a
 * read that directly follows another only after a setup with no body call since, or past eight reads
 * in a row. The body's run, where no more than eight reads follow a body call, reads only the body's
 * cost, while the empty body's run moves the clock on its own. Stubs `globalThis.gc` with a no-op.
 *
 * @param kind - The benchmark's lifecycle.
 * @returns The benchmark and its scripted clock.
 */
function bodyTimedOnly(kind: Kind): Scripted {
  let afterSetup = false;
  const clock = steppedClock((reads) => (afterSetup || reads > 8 ? STEP_MS : 0));
  vi.stubGlobal("gc", () => undefined);
  return {
    benchmark: {
      kind,
      setup: () => {
        afterSetup = true;
        clock.advance(0);
        return 0;
      },
      fn: () => {
        afterSetup = false;
        clock.advance(100);
      },
      teardown: () => {
        afterSetup = false;
        clock.advance(0);
      },
    },
    now: clock.now,
  };
}

/** V8's garbage collector, exposed through a flag set at run time. */
function exposedGc(...args: unknown[]): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 exposed no gc function");
  return () => {
    Reflect.apply(gc, undefined, args);
  };
}

describe("measure on a shared-context benchmark", () => {
  it("builds one context, runs every body call on it across the collection, then tears it down once", async () => {
    const fake = bench("sharedContext");

    await run(fake);

    const events = fake.log.filter((entry) => entry !== "noInline");
    const fromBody = events.slice(events.indexOf("fn 0"), events.indexOf("teardown 0") + 1);
    expect(events.filter((entry) => entry.startsWith("setup"))).toStrictEqual(["setup 0"]);
    expect(events.filter((entry) => entry.startsWith("teardown"))).toStrictEqual(["teardown 0"]);
    expect(fromBody.filter((entry, i) => entry !== fromBody[i - 1])).toStrictEqual([
      "fn 0",
      "gc",
      "fn 0",
      "teardown 0",
    ]);
  });

  it("runs without a teardown", async () => {
    const fake = bench("sharedContext", { teardown: false });

    const result = await run(fake);

    expect(result.samples).toBe(64);
  });
});

describe("measure on a per-call benchmark", () => {
  it("runs each body call on a fresh context, built before it and torn down after it", async () => {
    const fake = bench("perCall", { bodyMs: 200 });

    await run(fake);

    const lifecycle = fake.log.filter((entry) => entry !== "gc" && entry !== "noInline");
    const ids = bodyCalls(lifecycle).map((entry) => entry.slice("fn ".length));
    expect(ids.length).toBeGreaterThan(64);
    expect(lifecycle).toStrictEqual(
      ids.flatMap((id) => [`setup ${id}`, `fn ${id}`, `teardown ${id}`]),
    );
  });
});

describe("measure without an exposed gc", () => {
  it("rejects a benchmark in phase process before anything runs", async () => {
    const fake = bench("sharedContext");
    vi.stubGlobal("gc", undefined);

    const error = await failure(run(fake));

    expect(error.phase).toBe("process");
    expect(fake.log).toStrictEqual([]);
  });
});

describe("measure's synchronous-body check", () => {
  it.each(
    KINDS.flatMap((kind) => [
      { kind, what: "a promise", value: (): unknown => Promise.resolve() },
      // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
      { kind, what: "an object with a then method", value: (): unknown => ({ then: () => 0 }) },
    ]),
  )(
    "fails a $kind run whose body returns $what on its first call in phase fn, after tearing its context down",
    async ({ kind, value }) => {
      const fake = bench(kind, { returns: value });

      const error = await failure(run(fake));

      expect(error.phase).toBe("fn");
      expect(bodyCalls(fake.log)).toHaveLength(1);
      expect(fake.live.size).toBe(0);
    },
  );

  it("accepts a body returning an object whose then is not a function", async () => {
    // oxlint-disable-next-line unicorn/no-thenable -- a `then` that is not a function is the input under test
    const fake = bench("sharedContext", { returns: () => ({ then: "banana" }) });

    const result = await run(fake);

    expect(result.samples).toBe(64);
  });
});

describe("measure's error handling", () => {
  // One call per sample of 200 ms on both kinds. Shared context: body call 0 is the
  // synchronous-body check, calls 1-16 warm up, timing starts at call 17. Per call: the same, since
  // 16 samples of 200 ms pass the 3000 ms warmup minimum, with call 17 the collection's run outside
  // any clock read and timing from call 18; setup and teardown calls count the same way.
  const BUILD_OR_BODY_FAILURES = [
    { kind: "sharedContext", when: "the setup throws", fails: { setup: 0 }, from: "setup" },
    {
      kind: "sharedContext",
      when: "the check's body call throws",
      fails: { fn: 0 },
      from: "fn",
    },
    { kind: "sharedContext", when: "the body throws in warmup", fails: { fn: 5 }, from: "fn" },
    { kind: "sharedContext", when: "the body throws in timing", fails: { fn: 20 }, from: "fn" },
    { kind: "perCall", when: "the check's setup throws", fails: { setup: 0 }, from: "setup" },
    { kind: "perCall", when: "a warmup setup throws", fails: { setup: 3 }, from: "setup" },
    { kind: "perCall", when: "the collection's setup throws", fails: { setup: 17 }, from: "setup" },
    { kind: "perCall", when: "a timing setup throws", fails: { setup: 20 }, from: "setup" },
    { kind: "perCall", when: "the check's body call throws", fails: { fn: 0 }, from: "fn" },
    { kind: "perCall", when: "the body throws in warmup", fails: { fn: 5 }, from: "fn" },
    { kind: "perCall", when: "the collection's body throws", fails: { fn: 17 }, from: "fn" },
    { kind: "perCall", when: "the body throws in timing", fails: { fn: 20 }, from: "fn" },
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

  it.each(BUILD_OR_BODY_FAILURES)(
    "tears down every context a $kind run built when $when",
    async ({ kind, fails }) => {
      const fake = bench(kind, { bodyMs: 200, fails });

      await run(fake).catch(() => undefined);

      expect(fake.live.size).toBe(0);
      expect(fake.log.filter((entry) => entry.startsWith("teardown"))).toHaveLength(
        fake.log.filter((entry) => entry.startsWith("setup")).length,
      );
    },
  );

  const PER_CALL_TEARDOWN_FAILURES = [
    { kind: "perCall", when: "the check's teardown throws", fails: { teardown: 0 } },
    { kind: "perCall", when: "a warmup teardown throws", fails: { teardown: 2 } },
    { kind: "perCall", when: "the collection's teardown throws", fails: { teardown: 17 } },
    { kind: "perCall", when: "a timing teardown throws", fails: { teardown: 20 } },
  ] as const;

  it.each([
    { kind: "sharedContext", when: "the one teardown throws", fails: { teardown: 0 } },
    ...PER_CALL_TEARDOWN_FAILURES,
  ] as const)(
    "rejects a $kind run whose body succeeded in phase teardown with the teardown's value as cause when $when",
    async ({ kind, fails }) => {
      const fake = bench(kind, { bodyMs: 200, fails });

      const error = await failure(run(fake));

      expect(error.phase).toBe("teardown");
      expect(error.cause).toBe(fake.teardownError);
    },
  );

  // Teardown call n releases context n, and a teardown call that does not throw drops its context
  // from the live set: a second teardown of the context that threw would drop it too.
  it.each(PER_CALL_TEARDOWN_FAILURES)(
    "leaves alive only the context whose teardown threw when $when",
    async ({ kind, fails }) => {
      const fake = bench(kind, { bodyMs: 200, fails });

      await run(fake).catch(() => undefined);

      expect([...fake.live].map((world) => world.id)).toStrictEqual([fails.teardown]);
    },
  );

  it.each([
    { kind: "sharedContext", fails: { fn: 5, teardown: 0 } },
    { kind: "perCall", fails: { fn: 5, teardown: 5 } },
  ] as const)(
    "rejects a $kind run in phase fn with the body's value as cause when the cleanup's teardown throws too",
    async ({ kind, fails }) => {
      const fake = bench(kind, { bodyMs: 200, fails });

      const error = await failure(run(fake));

      expect(error.phase).toBe("fn");
      expect(error.cause).toBe(fake.fnError);
    },
  );

  it.each(KINDS)(
    "rejects a %s run whose collection throws in phase process with the collector's value as cause, after tearing its contexts down",
    async (kind) => {
      const fake = bench(kind, { bodyMs: 200 });
      const collectorError = new Error("durian");
      vi.stubGlobal("gc", () => {
        throw collectorError;
      });

      const error = await failure(run(fake));

      expect(error.phase).toBe("process");
      expect(error.cause).toBe(collectorError);
      expect(fake.live.size).toBe(0);
    },
  );

  it.each(KINDS)(
    "rejects a %s run whose body throws an Error worded as the cap's in phase fn",
    async (kind) => {
      const own = new Error(capMessage());
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

  it("rejects a shared-context run whose third timing run is discarded too in phase budget", async () => {
    const fake = fasterEveryRun();

    const error = await failure(measure(fake.benchmark, { now: fake.now }));

    expect(error.phase).toBe("budget");
    expect(error.cause).toBeInstanceOf(BudgetError);
  });

  // A clock that steps 1e-9 ms puts the cap at two calls per sample, and a body that moves the clock
  // by nothing spans no step, so warmup's first sample asks for 100 calls.
  it("rejects a per-call run whose warmup count passes the cap in phase budget, the sampler's error as cause", async () => {
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

    expect(error.phase).toBe("budget");
    expect(error.cause).toBeInstanceOf(BudgetError);
  });

  it("rejects a run whose callback throws a value with no string form in phase setup, that value as cause", async () => {
    const unprintable: unknown = Object.create(null);
    vi.stubGlobal("gc", () => undefined);
    const benchmark: Case<number> = {
      kind: "sharedContext",
      setup: () => {
        throw unprintable;
      },
      fn: () => 0,
    };

    const error = await failure(measure(benchmark, { now: steppedClock().now }));

    expect(error.phase).toBe("setup");
    expect(error.cause).toBe(unprintable);
  });

  it("rejects a run whose empty body's collection throws in phase process, the collector's value as cause", async () => {
    const fake = bench("perCall", { bodyMs: 200 });
    const collectorError = new Error("durian");
    let collections = 0;
    vi.stubGlobal("gc", () => {
      collections += 1;
      if (collections > 1) throw collectorError;
    });

    const error = await failure(run(fake));

    expect(error.phase).toBe("process");
    expect(error.cause).toBe(collectorError);
  });
});

describe("measure's noInline", () => {
  it("hands an injected noInline the body itself and one empty body, before any body call or collection", async () => {
    const fake = bench("sharedContext", { bodyMs: 200 });

    await run(fake);

    const before = Math.min(fake.log.indexOf("gc"), fake.log.indexOf("fn 0"));
    expect(fake.inlined).toHaveLength(2);
    expect(new Set(fake.inlined).size).toBe(2);
    expect(fake.inlined).toContain(fake.benchmark.fn);
    expect(fake.log.lastIndexOf("noInline")).toBeLessThan(before);
  });

  it("never imports bun:jsc on Node, when loading `measure` or measuring", async () => {
    const loaded: string[] = [];
    vi.resetModules();
    vi.doMock("bun:jsc", () => {
      loaded.push("bun:jsc");
      return {
        noInline: () => {
          loaded.push("noInline");
        },
      };
    });
    onTestFinished(() => {
      vi.doUnmock("bun:jsc");
    });
    const fresh = await import("../../src/measure/measure.js");
    const fake = bench("sharedContext");

    await fresh.measure(fake.benchmark, { now: fake.now, callsPerSample: 1 });

    expect(loaded).toStrictEqual([]);
  });
});

describe("measure's empty-body check", () => {
  // The empty body spans one clock step per sample, 125000 ns per call at one call per sample.
  it("fails a run whose body costs under 1.42 times the empty body in phase check, naming both readings", async () => {
    const fake = bench("sharedContext", { bodyMs: 1.375 * STEP_MS });

    const error = await failure(run(fake));

    expect(error.phase).toBe("check");
    expect(error.message).toMatch(/171875[^]*125000|125000[^]*171875/);
  });

  it("returns the ratio of the body's mean to the empty body's at 1.4375", async () => {
    const fake = bench("sharedContext", { bodyMs: 1.4375 * STEP_MS });

    const result = await run(fake);

    expect(result.emptyRatio).toBeCloseTo(1.4375, 6);
  });

  it("times the empty body only after the body's last call", async () => {
    const fake = bench("sharedContext", { bodyMs: 200 });

    await run(fake);

    const events = fake.log
      .filter((entry) => entry === "gc" || entry.startsWith("fn"))
      .map((entry) => (entry === "gc" ? entry : "fn"));
    expect(events.filter((entry, i) => entry !== events[i - 1])).toStrictEqual([
      "fn",
      "gc",
      "fn",
      "gc",
    ]);
  });

  // The scripted clock reads one step across any batch, so each warmup sample asks for 200 times
  // the calls: 1, 200, 40 000, 8 000 000, then 1 600 000 000 against a cap of 250 000 000.
  it("fails a shared-context run whose empty body asks for more calls per sample than the cap in phase budget, naming both", async () => {
    const fake = bench("sharedContext");

    const error = await failure(
      measure(fake.benchmark, { now: fake.now, noInline: fake.noInline }),
    );

    expect(error.phase).toBe("budget");
    expect(error.message).toMatch(/1600000000[^]*250000000/);
  });

  // Two calls per sample: summed per-call spans read one step per empty call, a batched pair of
  // clock reads one step per two calls.
  it("times a per-call run's empty body as summed per-call spans", async () => {
    const fake = bench("perCall");

    const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

    expect(result.emptyRatio).toBeCloseTo(800, 6);
  });
});

describe("measure's time and samples", () => {
  it.each(KINDS)("times a %s body until both given have passed", async (kind) => {
    const fake = bench(kind);

    const result = await measure(fake.benchmark, {
      now: fake.now,
      callsPerSample: 1,
      noInline: fake.noInline,
      time: 2950,
      samples: 10,
    });

    expect(result.samples).toBe(30);
  });
});

describe("measure's result", () => {
  it("returns the timed statistics with the step, the fixed count, the collection and the empty ratio", async () => {
    const fake = bench("sharedContext");

    const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

    expect(result).toStrictEqual({
      min: 100_000_000,
      p25: 100_000_000,
      median: 100_000_000,
      p75: 100_000_000,
      p99: 100_000_000,
      max: 100_000_000,
      mean: 100_000_000,
      samples: 64,
      timerStepNs: 125_000,
      callsPerSample: 2,
      countFixed: true,
      collected: true,
      emptyRatio: 1600,
      gcDuringTiming: expect.any(Object),
      timingRuns: 1,
      warmupSamples: 16,
      timingMs: expect.any(Number),
    });
  });

  it("reports two timing runs for a body that gets faster after warmup settled the count", async () => {
    const fake = fasterAfterWarmup();

    const result = await measure(fake.benchmark, { now: fake.now });

    expect(result.timingRuns).toBe(2);
  });

  it("settles its own count on the real clock when given none", { timeout: 15_000 }, async () => {
    vi.stubGlobal("gc", exposedGc());
    const benchmark: Case<{ readonly values: number[]; total: number }> = {
      kind: "sharedContext",
      setup: () => ({ values: Array.from({ length: 64 }, (_, index) => index), total: 0 }),
      fn: (world) => {
        for (const value of world.values) world.total += value;
      },
    };

    const result = await measure(benchmark);

    expect(result.countFixed).toBe(false);
    expect(result.callsPerSample).toBeGreaterThanOrEqual(1);
    expect(result.emptyRatio).toBeGreaterThanOrEqual(1.42);
  });
});

describe("measure's result, read from the body's run", () => {
  // The body costs 800 steps a call, so its warmup settles on one call per sample. At most three
  // reads follow a body call while the body runs; the empty body's first sample ends on the fifth
  // read after the body's last call and spans 100 steps, every later one 200, so the empty body's
  // warmup settles on two calls per sample: 100 steps per call, a ratio of 8.
  it("reports the count the body's warmup settled on, not the empty body's", async () => {
    let bodyCalled = false;
    const clock = steppedClock((reads) => {
      if (!bodyCalled || reads <= 2) return STEP_MS;
      return (reads === 5 ? 100 : 200) * STEP_MS;
    });
    vi.stubGlobal("gc", () => undefined);
    const benchmark: Case<number> = {
      kind: "sharedContext",
      setup: () => 0,
      fn: () => {
        bodyCalled = true;
        clock.advance(800 * STEP_MS);
      },
    };

    const result = await measure(benchmark, { now: clock.now });

    expect(result.emptyRatio).toBeCloseTo(8, 6);
    expect(result.callsPerSample).toBe(1);
  });

  it.each(KINDS)("reports the warmup samples of a %s body's run", async (kind) => {
    const fake = bodyTimedOnly(kind);

    const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

    expect(result.warmupSamples).toBe(16);
  });

  it.each(KINDS)("reports the timing length of a %s body's run", async (kind) => {
    const fake = bodyTimedOnly(kind);

    const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

    expect(result.timingMs).toBe(12_800);
  });
});

describe("measure's collections during timing", () => {
  it("reports the collections a body forces while timed, with their total and longest duration", async () => {
    const gc = exposedGc();
    const fake = bench("sharedContext", { returns: gc });
    vi.stubGlobal("gc", gc);

    const result = await run(fake);

    const observed = result.gcDuringTiming;
    expect(observed?.count).toBeGreaterThanOrEqual(1);
    expect(observed?.major).toBeGreaterThanOrEqual(1);
    expect(observed?.maxMs).toBeGreaterThan(0);
    expect(observed?.totalMs).toBeGreaterThanOrEqual(observed?.maxMs ?? Number.NaN);
  });

  it("counts the minor collections a body forces while timed", async () => {
    const fake = bench("sharedContext", { returns: exposedGc({ type: "minor" }) });

    const result = await run(fake);

    expect(result.gcDuringTiming?.minor).toBeGreaterThanOrEqual(1);
  });

  it("counts the collection a body forces during the kept timing run, leaving out those it forces during a discarded one", async () => {
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

  it("counts none for a body that allocates nothing, leaving out the collection before timing", async () => {
    const clock = steppedClock();
    vi.stubGlobal("gc", exposedGc());
    const benchmark: Case<number> = {
      kind: "sharedContext",
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

describe("runningEngine", () => {
  it("reads Node under Node", () => {
    const engine = runningEngine();

    expect(engine).toBe("node");
  });
});

const MEASURE_PATH = fileURLToPath(new URL("../../src/measure/measure.ts", import.meta.url));
const ENGINE_PATH = fileURLToPath(new URL("../../src/measure/engine.ts", import.meta.url));

/** Bun starting, then a few real-clock measurements of about 1.25 s each, on a slow CI runner. */
const BUN_TIMEOUT_MS = 60_000;

/** A cheap shared-context benchmark well above the empty body's cost, as script source. */
const SCRIPT_BENCH = `
const values = Array.from({ length: 64 }, (_, index) => index);
let sink = 0;
const setup = () => ({ values });
const fn = (world) => { for (const value of world.values) sink += value; };
`;

interface BunTestRun {
  readonly status: number | null;
  readonly stderr: string;
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
 * @returns How `bun test` exited, its stderr, and the parsed report.
 * @throws Error from the filesystem when the temporary directory or test file cannot be written.
 * @throws SyntaxError when the printed report is not valid JSON.
 */
function bunTestWithNoInlineMock(
  body: string,
  bunJsc = "() => ({ noInline: (fn) => { received.push(fn); } })",
): BunTestRun {
  const dir = mkdtempSync(join(tmpdir(), "repset-bun-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
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
  return { status: child.status, stderr: child.stderr, report: JSON.parse(report ?? "null") };
}

describe.runIf(requiresRealBunHere())("measure under real Bun", () => {
  it(
    "measures a shared-context benchmark with bun:jsc loaded, reporting no gc entries",
    () => {
      const script = `
const { measure } = await import(${JSON.stringify(MEASURE_PATH)});
const { runningEngine } = await import(${JSON.stringify(ENGINE_PATH)});
${SCRIPT_BENCH}
const result = await measure({ kind: "sharedContext", setup, fn });
console.log(JSON.stringify({
  engine: runningEngine(),
  observesGc: "gcDuringTiming" in result,
  samples: result.samples,
  sank: sink > 0,
}));
`;

      const child = spawnSync("bun", ["--expose-gc", "-e", script], { encoding: "utf8" });

      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toStrictEqual({
        engine: "bun",
        observesGc: false,
        samples: expect.any(Number),
        sank: true,
      });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "hands bun:jsc's noInline each body itself and one empty body before the body's first call",
    () => {
      const bun = bunTestWithNoInlineMock(`
  const report = {};
  for (const kind of ["sharedContext", "perCall"]) {
    received.length = 0;
    let sawItself;
    const timed = (world) => {
      sawItself ??= received.includes(timed);
      fn(world);
    };
    await measure({ kind, setup, fn: timed });
    report[kind] = {
      received: received.length,
      distinct: new Set(received).size,
      fn: received.includes(timed),
      sawItself,
    };
  }
  console.log("REPORT " + JSON.stringify(report));
`);

      expect({ status: bun.status, stderr: bun.stderr }).toMatchObject({ status: 0 });
      const each = { received: 2, distinct: 2, fn: true, sawItself: true };
      expect(bun.report).toStrictEqual({ sharedContext: each, perCall: each });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "leaves bun:jsc's noInline unused when one is injected",
    () => {
      const bun = bunTestWithNoInlineMock(`
  const injected = [];
  await measure({ kind: "sharedContext", setup, fn }, { noInline: (fn) => { injected.push(fn); } });
  console.log("REPORT " + JSON.stringify({ bunJsc: received.length, injected: injected.length }));
`);

      expect({ status: bun.status, stderr: bun.stderr }).toMatchObject({ status: 0 });
      expect(bun.report).toStrictEqual({ bunJsc: 0, injected: 2 });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "rejects in phase process with the loader's value as cause when bun:jsc cannot be loaded",
    () => {
      const bun = bunTestWithNoInlineMock(
        `
  const error = await measure({ kind: "sharedContext", setup, fn }).then(() => null, (e) => e);
  console.log("REPORT " + JSON.stringify({
    measureError: error instanceof MeasureError,
    phase: error?.phase,
    cause: error?.cause === loadFailure,
  }));
`,
        "() => { throw loadFailure; }",
      );

      expect({ status: bun.status, stderr: bun.stderr }).toMatchObject({ status: 0 });
      expect(bun.report).toStrictEqual({ measureError: true, phase: "process", cause: true });
    },
    BUN_TIMEOUT_MS,
  );
});
