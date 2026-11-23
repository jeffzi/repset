import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { type Case, measure, MeasureError, summarize } from "../../src/measure/measure.js";
import { CalibrationError, WARMUP_MIN_SAMPLES } from "../../src/measure/sampler.js";
import { requiresRealBunHere } from "../helpers/real-bun.js";
import { temporaryDir } from "../helpers/temporary-dir.js";
import { trappedProxy } from "../helpers/thrown-values.js";
import { enabledGc, type Failures, type RecordedWorld, recordedLifecycle } from "./fixtures.js";

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

interface BenchOptions {
  readonly bodyMs?: number;
  readonly fails?: Failures;
  readonly returns?: () => unknown;
  readonly teardownThrows?: unknown;
  /** The call, counted from zero per callback, at which setup or teardown returns a thenable. */
  readonly thenableAt?: { readonly setup?: number; readonly teardown?: number };
  /** The call, counted from zero, at which teardown returns a value whose `then` read throws. */
  readonly raisingThenAt?: { readonly teardown?: number };
}

interface Bench {
  readonly benchmark: Case<RecordedWorld>;
  readonly now: () => number;
  readonly log: string[];
  readonly live: Set<RecordedWorld>;
  readonly setupError: Error;
  readonly fnError: string;
  readonly teardownError: unknown;
  readonly thenReadError: Error;
}

// oxlint-disable-next-line unicorn/no-thenable -- a thenable setup or teardown result is the input under test
const PENDING_THENABLE = { then: (): number => 0 };

/** Gives `value` a `then` property whose read throws `error`, and returns it. */
function withRaisingThen<T extends object>(value: T, error: Error): T {
  // oxlint-disable-next-line unicorn/no-thenable -- a then read that throws is the input under test
  return Object.defineProperty(value, "then", {
    get: () => {
      throw error;
    },
  });
}

/**
 * Builds a benchmark on a scripted clock: setup, fn and teardown log themselves, the body charges
 * `bodyMs` per call, and a clock read that directly follows another read finds the clock one resolution on.
 * Stubs `globalThis.gc` with a no-op.
 *
 * @param kind - The benchmark's lifecycle.
 * @param options - The body's cost per call, which calls throw, what the body returns, the value
 *   the teardown throws, the calls at which setup or teardown return a thenable, and the call at
 *   which teardown returns a value whose `then` read throws.
 * @returns The benchmark, its scripted clock, and the logs the tests read.
 */
function bench(kind: Kind, options: BenchOptions = {}): Bench {
  const {
    bodyMs = 100,
    fails = {},
    returns = () => undefined,
    thenableAt = {},
    raisingThenAt = {},
  } = options;
  const clock = steppedClock();
  const setupError = new Error("banana");
  const fnError = "apple";
  const teardownError = "teardownThrows" in options ? options.teardownThrows : { name: "cherry" };
  const thenReadError = new Error("grape");
  const lifecycle = recordedLifecycle({
    failAt: fails,
    thrown: { setup: setupError, fn: fnError, teardown: teardownError },
    world: (id) => (id === thenableAt.setup ? { id, ...PENDING_THENABLE } : { id }),
    onCall: () => {
      clock.advance(0);
    },
    afterFn: () => {
      clock.advance(bodyMs);
      return returns();
    },
    afterTeardown: (call) => {
      if (call === raisingThenAt.teardown) return withRaisingThen({}, thenReadError);
      return call === thenableAt.teardown ? PENDING_THENABLE : undefined;
    },
  });
  const benchmark: Case<RecordedWorld> = {
    kind,
    setup: lifecycle.setup,
    fn: lifecycle.fn,
    teardown: lifecycle.teardown,
  };
  vi.stubGlobal("gc", () => undefined);
  return {
    benchmark,
    now: clock.now,
    log: lifecycle.log,
    live: lifecycle.live,
    setupError,
    fnError,
    teardownError,
    thenReadError,
  };
}

/** Measures a benchmark on its scripted clock at a fixed count of one call per sample. */
function run(fake: Bench): ReturnType<typeof measure> {
  return measure(fake.benchmark, { now: fake.now, callsPerSample: 1 });
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
  let world: RecordedWorld | undefined;
  const built = (): RecordedWorld => {
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
  return measure(benchmark, { now: fake.now, callsPerSample: 1 });
}

/** Collects the process's unhandled rejections until the test that called it finishes. */
function recordUnhandledRejections(): unknown[] {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  onTestFinished(() => {
    process.off("unhandledRejection", record);
  });
  return unhandled;
}

/** The entries `callback` logged, one per call. */
function logged(log: readonly string[], callback: "setup" | "fn" | "teardown"): string[] {
  return log.filter((entry) => entry.startsWith(callback));
}

/** Stubs `globalThis.gc` with a collector that throws, and returns what it throws. */
function throwingCollector(): Error {
  const collectorError = new Error("durian");
  vi.stubGlobal("gc", () => {
    throw collectorError;
  });
  return collectorError;
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
 * counts measure's full collections from the body's first call.
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
  vi.stubGlobal("gc", (options?: NodeJS.GCOptions) => {
    if (calls > 0 && options?.type !== "minor") collections += 1;
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

/**
 * Builds a benchmark whose warmup count passes the sampler's cap: a clock whose resolution is 1e-9
 * ms puts the cap at two calls per sample, and a body that moves the clock by nothing spans no clock
 * change, so warmup's first sample asks for 100 calls. Stubs `globalThis.gc` with a no-op.
 *
 * @param kind - The benchmark's kind.
 * @returns The benchmark and its scripted clock.
 */
function passesTheCap(kind: Kind): Scripted {
  const clock = steppedClock(() => 1e-9);
  vi.stubGlobal("gc", () => undefined);
  return {
    benchmark: {
      kind,
      setup: () => 0,
      fn: () => {
        clock.advance(0);
      },
    },
    now: clock.now,
  };
}

// ---------------------------------------------------------------------------
// Real Bun runs
// ---------------------------------------------------------------------------

const MEASURE_PATH = fileURLToPath(new URL("../../src/measure/measure.ts", import.meta.url));

/** Bun starting, then a few real-clock measurements of about 1.25 s each, on a slow CI runner. */
const BUN_TIMEOUT_MS = 60_000;

/** The generated case's own timeout, under {@link BUN_TIMEOUT_MS} so Bun reports a slow case before the spawn is killed. */
const BUN_CASE_TIMEOUT_MS = 50_000;

/** A cheap shared-state benchmark well above the empty body's cost, as script source. */
const SCRIPT_BENCH = `
const values = Array.from({ length: 64 }, (_, index) => index);
let sink = 0;
const setup = () => ({ values });
const fn = (world) => { for (const value of world.values) sink += value; };
`;

/**
 * Runs `bun` with `args` to completion, killing it at {@link BUN_TIMEOUT_MS}.
 *
 * @param args - The arguments to `bun`.
 * @param cwd - The directory Bun starts in, this process's own when omitted.
 * @returns How Bun exited and what it printed.
 * @throws The spawn's own error, as when Bun cannot start or ran past its timeout.
 */
function runBun(args: readonly string[], cwd?: string): SpawnSyncReturns<string> {
  const child = spawnSync("bun", args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    timeout: BUN_TIMEOUT_MS,
  });
  if (child.error !== undefined) throw child.error;
  return child;
}

interface BunTestRun {
  readonly status: number | null;
  /** The JSON the test printed after `REPORT `, or `null` when it printed none. */
  readonly report: unknown;
}

/**
 * Runs `body` as one `bun test` case with `measure` imported, the benchmark of
 * {@link SCRIPT_BENCH} defined, a stub `gc`, a `loadFailure` object for a factory to throw, and
 * `bun:jsc` mocked by `bunJsc`.
 *
 * @param body - Statements of the async test case; one prints `REPORT ` followed by JSON.
 * @param bunJsc - The source of the factory `bun:jsc` is mocked with.
 * @returns How `bun test` exited and the parsed report.
 * @throws Error from the filesystem when the temporary directory or test file cannot be written.
 * @throws SyntaxError when the printed report is not valid JSON.
 * @throws The spawn's own error, as when Bun cannot start or ran past {@link BUN_TIMEOUT_MS}.
 */
function bunTestWithJscMock(body: string, bunJsc: string): BunTestRun {
  const dir = temporaryDir("repset-bun-");
  const file = join(dir, "jsc-mock.test.ts");
  writeFileSync(
    file,
    `
import { mock, test } from "bun:test";
const loadFailure = { name: "durian" };
mock.module("bun:jsc", ${bunJsc});
globalThis.gc = () => {};
test("jsc mock", async () => {
  const { measure } = await import(${JSON.stringify(MEASURE_PATH)});
  ${SCRIPT_BENCH}
${body}
}, ${BUN_CASE_TIMEOUT_MS});
`,
  );

  const child = runBun(["test", file], dir);

  const report = /REPORT (.*)/.exec(`${child.stdout}\n${child.stderr}`)?.[1];
  return { status: child.status, report: JSON.parse(report ?? "null") };
}

// ---------------------------------------------------------------------------
// measure, in process
// ---------------------------------------------------------------------------

describe("measure", () => {
  describe("on a shared-state benchmark", () => {
    it("builds one state", async () => {
      const fake = bench("sharedState");

      await run(fake);

      expect(logged(fake.log, "setup")).toStrictEqual(["setup 0"]);
    });

    it("tears its one state down once", async () => {
      const fake = bench("sharedState");

      await run(fake);

      expect(logged(fake.log, "teardown")).toStrictEqual(["teardown 0"]);
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
        expect(logged(fake.log, "fn")).toHaveLength(1);
      },
    );

    it("leaves no rejection unhandled when the body returns a rejected promise", async () => {
      const unhandled = recordUnhandledRejections();
      const rejection = new Error("banana");
      const fake = bench("sharedState", { returns: () => Promise.reject(rejection) });

      const error = await failure(run(fake));
      await new Promise((resolve) => setImmediate(resolve));

      expect(error.phase).toBe("fn");
      expect(unhandled).not.toContain(rejection);
    });

    const thrown = new Error("cherry");
    const RAISING_THENABLE_CASES = [
      {
        when: "its then getter throws after the check reads it",
        returns: (): unknown => {
          let reads = 0;
          return {
            // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
            get then(): () => void {
              reads += 1;
              if (reads > 1) throw thrown;
              return () => undefined;
            },
          };
        },
      },
      {
        when: "its then call throws",
        returns: (): unknown => ({
          // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
          then: () => {
            throw thrown;
          },
        }),
      },
    ];

    it.each(RAISING_THENABLE_CASES)(
      "fails a run whose body returns a thenable in phase fn for the thenable when $when",
      async ({ returns }) => {
        const fake = bench("sharedState", { returns });

        const error = await failure(run(fake));

        expect(error.phase).toBe("fn");
        expect(error.cause).not.toBe(thrown);
      },
    );

    it("accepts a body returning an object whose then is not a function", async () => {
      // oxlint-disable-next-line unicorn/no-thenable -- a `then` that is not a function is the input under test
      const fake = bench("sharedState", { returns: () => ({ then: "banana" }) });

      const result = await run(fake);

      expect(result.stats.sampleCount).toBe(64);
    });
  });

  describe("when its setup or teardown returns a thenable", () => {
    it.each(KINDS)("fails a %s run whose setup returns a thenable in phase setup", async (kind) => {
      const fake = bench(kind, { thenableAt: { setup: 0 } });

      const error = await failure(run(fake));

      expect(error.phase).toBe("setup");
    });

    it.each(KINDS)(
      "tears down the thenable state a %s run's setup returned, once",
      async (kind) => {
        const fake = bench(kind, { thenableAt: { setup: 0 } });

        await run(fake).catch(() => undefined);

        expect(fake.log.filter((entry) => entry === "teardown 0")).toStrictEqual(["teardown 0"]);
      },
    );

    const TEARDOWN_THENABLE_CASES = [
      { kind: "sharedState", when: "its one teardown" },
      { kind: "perCall", when: "the check's teardown" },
    ] as const;

    it.each(TEARDOWN_THENABLE_CASES)(
      "fails a $kind run in phase teardown when $when returns a thenable",
      async ({ kind }) => {
        const fake = bench(kind, { thenableAt: { teardown: 0 } });

        const error = await failure(run(fake));

        expect(error.phase).toBe("teardown");
      },
    );

    it.each(TEARDOWN_THENABLE_CASES)(
      "tears a $kind run's state down once when $when returns a thenable",
      async ({ kind }) => {
        const fake = bench(kind, { thenableAt: { teardown: 0 } });

        await run(fake).catch(() => undefined);

        expect(fake.log.filter((entry) => entry === "teardown 0")).toHaveLength(1);
      },
    );
  });

  describe("when its callback's return value throws on reading then", () => {
    it("fails a shared-state run in phase teardown with the read's error as cause when its teardown's return value throws on reading then", async () => {
      const fake = bench("sharedState", { raisingThenAt: { teardown: 0 } });

      const error = await failure(run(fake));

      expect(error.phase).toBe("teardown");
      expect(error.cause).toBe(fake.thenReadError);
    });
  });

  describe("when a callback or the collector throws", () => {
    /** A body cost long enough that each sample is one call. */
    const LONG_BODY_MS = 200;

    // One call per sample of 200 ms on both kinds. Body call 0 is the synchronous-body check and
    // calls 1-16 warm up; setup and teardown calls count the same way.
    const BUILD_OR_BODY_FAILURES = [
      { kind: "sharedState", when: "the setup throws", fails: { setup: 0 }, from: "setup" },
      { kind: "perCall", when: "the check's setup throws", fails: { setup: 0 }, from: "setup" },
      { kind: "perCall", when: "the check's body call throws", fails: { fn: 0 }, from: "fn" },
    ] as const;

    it.each(BUILD_OR_BODY_FAILURES)(
      "rejects a $kind run in phase $from with the thrown value itself as cause when $when",
      async ({ kind, fails, from }) => {
        const fake = bench(kind, { bodyMs: LONG_BODY_MS, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe(from);
        expect(error.cause).toBe(from === "setup" ? fake.setupError : fake.fnError);
      },
    );

    it("tears down every state a per-call run built when the body throws in warmup", async () => {
      const fake = bench("perCall", { bodyMs: LONG_BODY_MS, fails: { fn: 5 } });

      await run(fake).catch(() => undefined);

      expect(fake.live.size).toBe(0);
      expect(logged(fake.log, "teardown")).toHaveLength(logged(fake.log, "setup").length);
    });

    it.each([
      { kind: "sharedState", when: "the one teardown throws", fails: { teardown: 0 } },
      { kind: "perCall", when: "the check's teardown throws", fails: { teardown: 0 } },
      { kind: "perCall", when: "a warmup teardown throws", fails: { teardown: 2 } },
    ] as const)(
      "rejects a $kind run whose body succeeded in phase teardown with the teardown's value as cause when $when",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: LONG_BODY_MS, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe("teardown");
        expect(error.cause).toBe(fake.teardownError);
      },
    );

    // Teardown call n releases state n, and a teardown call that does not throw drops its state
    // from the live set: a second teardown of the state that threw would drop it too.
    it("leaves alive only the state whose teardown threw", async () => {
      const fails = { teardown: 2 };
      const fake = bench("perCall", { bodyMs: LONG_BODY_MS, fails });

      await run(fake).catch(() => undefined);

      expect([...fake.live].map((world) => world.id)).toStrictEqual([fails.teardown]);
    });

    it("rejects a per-call run whose setup returns undefined in phase fn when the body throws in warmup", async () => {
      const fake = bench("perCall", { bodyMs: LONG_BODY_MS, fails: { fn: 5 } });

      const error = await failure(runOnUndefined(fake));

      expect(error.phase).toBe("fn");
    });

    it("tears down every state a per-call run whose setup returns undefined built when the body throws in warmup", async () => {
      const fake = bench("perCall", { bodyMs: LONG_BODY_MS, fails: { fn: 5 } });

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
        const fake = bench(kind, { bodyMs: LONG_BODY_MS, fails });

        const error = await failure(run(fake));

        expect(error.phase).toBe("fn");
        expect(error.cause).toBe(fake.fnError);
      },
    );

    it.each(BODY_AND_CLEANUP_FAILURES)(
      "keeps the cleanup's teardown failure on a $kind run's error in phase teardown, the teardown's value as cause, when the body throws first",
      async ({ kind, fails }) => {
        const fake = bench(kind, { bodyMs: LONG_BODY_MS, fails });

        const error = await failure(run(fake));

        expect(error.teardownError?.phase).toBe("teardown");
        expect(error.teardownError?.cause).toBe(fake.teardownError);
      },
    );

    it("keeps the cleanup's teardown failure in phase teardown on a per-call run whose body fails with a MeasureError", async () => {
      const fake = bench("perCall", { returns: () => PENDING_THENABLE, fails: { teardown: 0 } });

      const error = await failure(run(fake));

      expect(error.phase).toBe("fn");
      expect(error.teardownError?.phase).toBe("teardown");
      expect(error.teardownError?.cause).toBe(fake.teardownError);
    });

    it("keeps a cleanup teardown that throws null on the body's error, null as cause", async () => {
      const fake = bench("perCall", {
        bodyMs: LONG_BODY_MS,
        fails: { fn: 5, teardown: 5 },
        teardownThrows: null,
      });

      const error = await failure(run(fake));

      expect(error.teardownError?.cause).toBeNull();
    });

    it("rejects a shared-state run whose collection throws and whose cleanup's teardown throws in phase child, the collector's value as cause", async () => {
      const fake = bench("sharedState", { bodyMs: LONG_BODY_MS, fails: { teardown: 0 } });
      const collectorError = throwingCollector();

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
      expect(error.cause).toBe(collectorError);
    });

    it("rejects a per-call run whose collection throws in phase child with the collector's value as cause", async () => {
      const fake = bench("perCall", { bodyMs: LONG_BODY_MS });
      const collectorError = throwingCollector();

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
      expect(error.cause).toBe(collectorError);
    });

    it("rejects a run whose body throws a value whose instanceof check throws in phase fn, that value as cause", async () => {
      const trapped = trappedProxy();
      vi.stubGlobal("gc", () => undefined);
      const benchmark: Case<number> = {
        kind: "sharedState",
        setup: () => 0,
        fn: () => {
          // oxlint-disable-next-line typescript/only-throw-error -- a thrown value whose instanceof check throws is the input under test
          throw trapped;
        },
      };

      const error = await failure(measure(benchmark, { now: steppedClock().now }));

      expect(error.phase).toBe("fn");
      expect(error.cause).toBe(trapped);
    });

    it("rejects a run whose empty body's collection throws in phase child, the collector's value as cause", async () => {
      const fake = bench("sharedState", { bodyMs: LONG_BODY_MS });
      const collectorError = new Error("durian");
      // A shared-state run tears its state down once its body's run is over, so only the empty
      // body's collection finds the teardown logged.
      vi.stubGlobal("gc", () => {
        if (logged(fake.log, "teardown").length > 0) throw collectorError;
      });

      const error = await failure(run(fake));

      expect(error.phase).toBe("child");
      expect(error.cause).toBe(collectorError);
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

    it("returns the ratio to the empty body as it reads once 250 ms of the empty body's warmup have passed", async () => {
      const scripted = emptyBodyFasterAfter250Ms();

      const result = await measure(scripted.benchmark, { now: scripted.now, callsPerSample: 1 });

      expect(result.checks.ratioToEmptyBody).toBe(80);
    });

    // Two calls per sample: summed per-call spans read one resolution per empty call, a batched pair of
    // clock reads one resolution per two calls.
    it("times a per-call run's empty body as summed per-call spans", async () => {
      const fake = bench("perCall");

      const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

      expect(result.checks.ratioToEmptyBody).toBeCloseTo(800, 6);
    });
  });

  describe("when a count passes the cap", () => {
    it("fails a shared-state run whose empty body asks for more calls per sample than the cap in phase calibration", async () => {
      const fake = bench("sharedState");

      const error = await failure(measure(fake.benchmark, { now: fake.now }));

      expect(error.phase).toBe("calibration");
    });

    it.each(KINDS)(
      "rejects a %s run whose warmup count passes the cap in phase calibration, the sampler's error as cause",
      async (kind) => {
        const { benchmark, now } = passesTheCap(kind);

        const error = await failure(measure(benchmark, { now }));

        expect(error.phase).toBe("calibration");
        expect(error.cause).toBeInstanceOf(CalibrationError);
      },
    );
  });

  describe("when given minTime and minSamples", () => {
    it("times a body until both given have passed", async () => {
      const fake = bench("sharedState");

      const result = await measure(fake.benchmark, {
        now: fake.now,
        callsPerSample: 1,
        minTime: 2950,
        minSamples: 10,
      });

      expect(result.stats.sampleCount).toBe(30);
    });
  });

  describe("when it returns a result", () => {
    it("returns the timed statistics with the resolution, the fixed count, the collections seen while timing and the ratio to the empty body", async () => {
      const fake = bench("sharedState");

      const result = await measure(fake.benchmark, { now: fake.now, callsPerSample: 2 });

      expect(result).toStrictEqual({
        stats: {
          min: 100_000_000,
          p25: 100_000_000,
          median: 100_000_000,
          p75: 100_000_000,
          p99: 100_000_000,
          max: 100_000_000,
          mean: 100_000_000,
          sampleCount: 64,
        },
        sampling: {
          timerResolutionNs: 125_000,
          callsPerSample: 2,
          callsPerSampleFixed: true,
          warmupSampleCount: WARMUP_MIN_SAMPLES,
          timingAttemptCount: 1,
          timingMs: expect.any(Number),
        },
        checks: { ratioToEmptyBody: 1600 },
        gc: expect.objectContaining({ collectionCount: expect.any(Number) }),
      });
    });

    it("reports a count it settled itself as not fixed", async () => {
      const fake = fasterAfterWarmup();

      const result = await measure(fake.benchmark, { now: fake.now });

      expect(result.sampling.callsPerSampleFixed).toBe(false);
    });
  });

  describe("when counting collections during timing", () => {
    it("counts the forced GC a body forces during the kept timing attempt, leaving out those it forces during a discarded one", async () => {
      const gc = enabledGc();
      let forcedInKept = false;
      const fake = fasterAfterWarmup((collections) => {
        if (collections === 1) gc();
        if (collections === 2 && !forcedInKept) {
          forcedInKept = true;
          gc();
        }
      });

      const result = await measure(fake.benchmark, { now: fake.now });

      expect(result.gc?.collectionCount).toBe(1);
    });

    it("counts none for a body that allocates nothing, leaving out the forced GC before timing", async () => {
      const clock = steppedClock();
      vi.stubGlobal("gc", enabledGc());
      const benchmark: Case<number> = {
        kind: "sharedState",
        setup: () => 0,
        fn: () => {
          clock.advance(100);
        },
      };

      const result = await measure(benchmark, { now: clock.now, callsPerSample: 1 });

      expect(result.gc).toStrictEqual({
        collectionCount: 0,
        durationMs: 0,
        maxDurationMs: 0,
        nodeMinorCollectionCount: 0,
        nodeMajorCollectionCount: 0,
      });
    });
  });
});

describe("summarize", () => {
  it("reports per-call nanoseconds with percentiles interpolated between ranks when the spans are stored out of order", () => {
    const store = Float64Array.from([12, 4, 16, 8]);

    const statistics = summarize(store, 4, 4);

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

describe.runIf(requiresRealBunHere())("measure under real Bun", () => {
  it(
    "measures a shared-state benchmark with bun:jsc loaded, reporting no gc entries",
    () => {
      const script = `
const { measure } = await import(${JSON.stringify(MEASURE_PATH)});
${SCRIPT_BENCH}
const result = await measure({ kind: "sharedState", setup, fn });
console.log(JSON.stringify({
  observesGc: result.gc !== null,
}));
`;

      const child = runBun(["--expose-gc", "-e", script]);

      // oxlint-disable-next-line vitest/valid-expect -- Vitest takes a failure message as expect's second argument
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toStrictEqual({
        observesGc: false,
      });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "rejects in phase child with the loader's value as cause when bun:jsc cannot be loaded",
    () => {
      const bun = bunTestWithJscMock(
        `
  const error = await measure({ kind: "sharedState", setup, fn }).then(() => null, (e) => e);
  console.log("REPORT " + JSON.stringify({
    phase: error?.phase,
    cause: error?.cause === loadFailure,
  }));
`,
        "() => { throw loadFailure; }",
      );

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ phase: "child", cause: true });
    },
    BUN_TIMEOUT_MS,
  );
});
