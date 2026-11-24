import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ChildResult, failedResult, parseRequest } from "../src/child-protocol.js";
import {
  listCases,
  measureCase,
  runOnce,
  type CollectionDetector,
  type MemoryProbe,
} from "../src/child.js";
import { MeasureError } from "../src/measure/measure.js";
import { property } from "../src/utils.js";
import { fixturePath, ROOT } from "./helpers/fixture-path.js";
import { resetRegistry } from "./helpers/registry.js";
import { repeated } from "./helpers/repeated.js";
import { KILL_AFTER_MS, SPAWN_TIMEOUT_MS } from "./helpers/spawn-limits.js";
import { trappedProxy } from "./helpers/thrown-values.js";
import { enabledGc } from "./measure/fixtures.js";

/** The slot where the `lifecycle.ts` and `contest.ts` fixtures record each callback they run. */
const CALLS = Symbol.for("repset.child-calls");

/** The absolute path of the child fixture `name`. */
function fixture(name: string): string {
  return fixturePath("child", name);
}

const FILE = fixture("three-cases.ts");

/** What `FILE` lists: its three cases in registration order. */
const FILE_LISTED = {
  status: "ok",
  cases: [
    { id: "alpha", setupPerCall: false, name: "alpha", contender: null },
    { id: "beta", setupPerCall: true, name: "beta", contender: null },
    { id: "gamma", setupPerCall: false, name: "gamma", contender: null },
  ],
};

const SHORT_RUN = { minTime: 5, minSamples: 8 };

/** A short timing with no memory pass. */
const TIME_ONLY = { ...SHORT_RUN, time: true, memory: false };

/** The memory pass alone, with no timing. */
const MEMORY_ONLY = { ...SHORT_RUN, time: false, memory: true };

/** How long a short measurement may take on a slow CI runner. */
const MEASURE_TIMEOUT_MS = 15_000;

const MEASURE_REQUEST = { mode: "measure", file: FILE, id: "alpha", ...TIME_ONLY };

const LIFECYCLE = fixture("lifecycle.ts");

/** A plain benchmark, then the contest `sort` of the contenders `quick` and `merge`. */
const CONTEST = fixture("contest.ts");

/** The callbacks the fixtures recorded since the test began. */
function calls(): unknown[] {
  const recorded: unknown = Reflect.get(globalThis, CALLS);
  if (!Array.isArray(recorded)) throw new Error("no call list installed");
  return recorded;
}

/** Measures `id` of `file` with a short run. */
async function measureShort(file: string, id: string): Promise<ChildResult> {
  return measureCase(file, id, TIME_ONLY);
}

beforeEach(() => {
  vi.resetModules();
  resetRegistry();
  Reflect.set(globalThis, CALLS, []);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, CALLS);
});

describe("parseRequest", () => {
  describe("when the request is complete", () => {
    const unfixed = { ...MEASURE_REQUEST, callsPerSample: undefined };
    const fixed = { ...MEASURE_REQUEST, callsPerSample: 200 };
    it.each([
      {
        why: "a list request",
        request: { mode: "list", file: FILE },
        expected: { mode: "list", file: FILE },
      },
      {
        why: "a once request",
        request: { mode: "once", file: FILE, id: "alpha" },
        expected: { mode: "once", file: FILE, id: "alpha" },
      },
      { why: "a measure request", request: MEASURE_REQUEST, expected: unfixed },
      { why: "a measure request with its calls per sample", request: fixed, expected: fixed },
    ])("returns $why", ({ request, expected }) => {
      const parsed = parseRequest(JSON.stringify(request));

      expect(parsed).toStrictEqual(expected);
    });
  });

  describe("when the request is malformed", () => {
    it.each([
      { why: "not an object", error: /\b3\b/, argument: "3" },
      { why: "null", error: /\bnull\b/, argument: "null" },
      {
        why: "an unknown mode",
        error: /"walk"/,
        argument: JSON.stringify({ mode: "walk", file: FILE }),
      },
      {
        why: "a file that is not a string",
        error: /file/,
        argument: JSON.stringify({ mode: "list", file: 7 }),
      },
      {
        why: "a relative file",
        error: /bench\/sort\.ts/,
        argument: JSON.stringify({ mode: "list", file: "bench/sort.ts" }),
      },
      {
        why: "a callsPerSample that is a string",
        error: /\bcallsPerSample\b.*"200"/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, callsPerSample: "200" }),
      },
      {
        why: "a measure request with no time",
        error: /\btime\b/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, time: undefined }),
      },
    ])("throws a TypeError for $why", ({ argument, error }) => {
      const parse = (): unknown => parseRequest(argument);

      expect(parse).toThrow(TypeError);
      expect(parse).toThrow(error);
    });
  });
});

describe("failedResult", () => {
  describe("when the thrown value is an Error", () => {
    it("encodes it in the phase given, with its message and stack", () => {
      const error = new Error("banana");

      const result = failedResult("load", error);

      expect(result).toStrictEqual({
        status: "failed",
        error: { phase: "load", message: "banana", stack: error.stack, teardownError: null },
      });
    });
  });

  describe("when the thrown value is a MeasureError", () => {
    it("takes its own phase and message, and the stack of its cause", () => {
      const cause = new Error("kiwi");

      const result = failedResult("child", new MeasureError("fn", cause));

      expect(result).toStrictEqual({
        status: "failed",
        error: { phase: "fn", message: "kiwi", stack: cause.stack, teardownError: null },
      });
    });

    it("encodes its teardown failure as the message and stack of the Error it threw", () => {
      const melon = new Error("melon");
      const thrown = new MeasureError("fn", new Error("lime"), new MeasureError("teardown", melon));

      const result = failedResult("child", thrown);

      expect(result.error.teardownError).toStrictEqual({ message: "melon", stack: melon.stack });
    });
  });

  describe("when the thrown value's instanceof check throws", () => {
    it("encodes it in the phase given", () => {
      const result = failedResult("load", trappedProxy());

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "load", stack: null, teardownError: null },
      });
    });
  });
});

describe("listCases", () => {
  describe("when the file registers cases", () => {
    it("returns each case's id, setupPerCall, name and contender in registration order", async () => {
      const result = await listCases(FILE);

      expect(result).toStrictEqual(FILE_LISTED);
    });
  });

  describe("when the file registers a contest", () => {
    it("returns each contender's benchmark name and key beside a plain benchmark's null contender", async () => {
      const result = await listCases(CONTEST);

      expect(result).toStrictEqual({
        status: "ok",
        cases: [
          { id: "plain", setupPerCall: false, name: "plain", contender: null },
          { id: "sort/quick", setupPerCall: false, name: "sort", contender: "quick" },
          { id: "sort/merge", setupPerCall: false, name: "sort", contender: "merge" },
        ],
      });
    });
  });

  describe("when the file fails to load", () => {
    it("fails in phase load with the message of the Error the file threw", async () => {
      const result = await listCases(fixture("top-level-throw.ts"));

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "load", message: "banana" },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The memory pass, read through a fake heap and a fake collection detector
// ---------------------------------------------------------------------------

/** What the fake heap records in the call list at each reading. */
const READ = "read";

/** Mirrors `PASS_PAIRS` in `src/child.ts`: the samples counted below follow it. */
const PAIRS = 21;

/** Mirrors `PASS_CALLS` in `src/child.ts`, the calls per sample before any halving. */
const START_CALLS = 64;

/** How many entries of `entries` are fixture records ending in `suffix`. */
function count(entries: readonly unknown[], suffix: string): number {
  return entries.filter((entry) => typeof entry === "string" && entry.endsWith(suffix)).length;
}

/** The index of every heap reading in `log`, in order. */
function readIndices(log: readonly unknown[]): number[] {
  return log.flatMap((entry, index) => (entry === READ ? [index] : []));
}

/** The entries between each sample's two heap readings, one list per sample, in order. */
function samples(log: readonly unknown[]): unknown[][] {
  const reads = readIndices(log);
  return reads.flatMap((read, index) =>
    index % 2 === 0 ? [log.slice(read + 1, reads[index + 1])] : [],
  );
}

/** The states alive at each heap reading: setups recorded so far minus the states torn down. */
function liveAtReads(log: readonly unknown[]): number[] {
  return readIndices(log).map((read) => {
    const before = log.slice(0, read);
    return count(before, " setup") - count(before, " teardown");
  });
}

/**
 * A fake heap reading that records each read: `bytesPerCall` for every body call recorded so far,
 * plus `emptyExtra(n)` added at the second reading of the `n`-th empty sample, one with no body call.
 */
function fakeHeap(
  bytesPerCall: number,
  emptyExtra: (emptyIndex: number) => number = () => 0,
): () => number {
  let extra = 0;
  let emptyCount = 0;
  return () => {
    const log = calls();
    const ending = readIndices(log).length % 2 === 1;
    if (ending && count(log.slice(log.lastIndexOf(READ)), " fn") === 0) {
      extra += emptyExtra(emptyCount);
      emptyCount++;
    }
    log.push(READ);
    return count(log, " fn") * bytesPerCall + extra;
  };
}

/**
 * A fake detector that flags a body sample when `flags(calls, nth)` holds, `calls` being the body
 * calls the sample ran and `nth` how many body samples ran at that count before it, and flags an
 * empty sample, one with no body call, when `flagsEmpty(nth)` holds, `nth` counting the empty
 * samples before it.
 */
function fakeDetector(
  flags: (calls: number, nth: number) => boolean = () => false,
  flagsEmpty: (nth: number) => boolean = () => false,
): () => Promise<CollectionDetector> {
  const seen = new Map<number, number>();
  let empties = 0;
  return async () => ({
    start: () => undefined,
    stop: () => {
      const log = calls();
      const end = log.lastIndexOf(READ);
      const bodyCalls = count(log.slice(log.lastIndexOf(READ, end - 1), end), " fn");
      if (bodyCalls === 0) {
        empties++;
        return flagsEmpty(empties - 1) ? 1 : 0;
      }
      const nth = seen.get(bodyCalls) ?? 0;
      seen.set(bodyCalls, nth + 1);
      return flags(bodyCalls, nth) ? 1 : 0;
    },
  });
}

/** A probe whose heap grows `bytesPerCall` per body call and whose detector flags nothing. */
function cleanProbe(bytesPerCall = 0): MemoryProbe {
  return { heapUsed: fakeHeap(bytesPerCall), detector: fakeDetector() };
}

/** Runs the memory pass alone on `id` of the lifecycle fixture with `probe`. */
async function passOn(id: string, probe: MemoryProbe = cleanProbe()): Promise<ChildResult> {
  return measureCase(LIFECYCLE, id, MEMORY_ONLY, probe);
}

describe("measureCase", () => {
  beforeEach(() => {
    vi.stubGlobal("gc", enabledGc());
  });

  describe("when the id does not select exactly one case", () => {
    it("fails in phase load naming an id that is not registered", async () => {
      const result = await measureShort(FILE, "banana");

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "load", message: expect.stringContaining("banana") },
      });
    });
  });

  describe("when the case measures", { timeout: MEASURE_TIMEOUT_MS }, () => {
    it("measures at the calls per sample it is given", async () => {
      const result = await measureCase(LIFECYCLE, "steady", { ...TIME_ONLY, callsPerSample: 3 });

      expect(result).toMatchObject({ status: "ok", time: { sampling: { callsPerSample: 3 } } });
    });
  });

  describe("when time alone is asked", { timeout: MEASURE_TIMEOUT_MS }, () => {
    it("returns a null memory", async () => {
      const result = await measureCase(LIFECYCLE, "steady", TIME_ONLY, cleanProbe());

      expect(result).toMatchObject({ status: "ok", memory: null });
    });

    it("reads no heap", async () => {
      await measureCase(LIFECYCLE, "steady", TIME_ONLY, cleanProbe());

      expect(calls()).not.toContain(READ);
    });
  });

  describe("when memory is asked", { timeout: MEASURE_TIMEOUT_MS }, () => {
    beforeEach(() => {
      vi.stubGlobal("gc", () => undefined);
    });

    describe("when time is asked too", () => {
      it("returns the time block and the pass's memory block", async () => {
        const result = await measureCase(
          LIFECYCLE,
          "steady",
          { ...TIME_ONLY, memory: true },
          cleanProbe(),
        );

        expect(result).toMatchObject({
          status: "ok",
          time: { stats: { sampleCount: expect.any(Number) } },
          memory: {
            stats: { median: 0, sampleCount: PAIRS },
            sampling: { callsPerSample: START_CALLS },
            rawSamples: null,
          },
        });
      });
    });

    describe("when memory alone is asked", () => {
      it("returns a null time block", async () => {
        const result = await passOn("quiet");

        expect(result).toMatchObject({ status: "ok", time: null, memory: { rawSamples: null } });
      });

      it("calls the body only inside the pass's samples but for one first call", async () => {
        await passOn("quiet");

        const log = calls();
        const outside = count(log, " fn") - count(samples(log).flat(), " fn");
        expect(outside).toBeLessThanOrEqual(1);
      });
    });

    describe("when the runtime is Bun", () => {
      it("returns a null memory", async () => {
        vi.stubGlobal("Bun", {});

        const result = await passOn("quiet");

        expect(result).toStrictEqual({ status: "ok", time: null, memory: null });
      });

      it("reads no heap", async () => {
        vi.stubGlobal("Bun", {});

        await passOn("quiet");

        expect(calls()).not.toContain(READ);
      });
    });

    describe("when the case shares one state", () => {
      it("builds the state once, before the first heap reading", async () => {
        await passOn("quiet");

        const log = calls();
        const firstRead = log.indexOf(READ);
        expect({
          before: count(log.slice(0, firstRead), " setup"),
          after: count(log.slice(firstRead), " setup"),
        }).toStrictEqual({ before: 1, after: 0 });
      });

      it("tears the state down once, after the last heap reading", async () => {
        await passOn("quiet");

        const log = calls();
        const lastRead = log.lastIndexOf(READ);
        expect({
          before: count(log.slice(0, lastRead), " teardown"),
          after: count(log.slice(lastRead), " teardown"),
        }).toStrictEqual({ before: 0, after: 1 });
      });

      it("takes 21 pairs of a 64-call body sample and an empty sample", async () => {
        await passOn("quiet");

        const bodyCalls = samples(calls()).map((sample) => count(sample, " fn"));
        expect(bodyCalls.toSorted((a, b) => a - b)).toStrictEqual([
          ...repeated(0, PAIRS),
          ...repeated(START_CALLS, PAIRS),
        ]);
      });
    });

    describe("when the case builds a state per call", () => {
      it("holds as many states at each heap reading as the sample's calls", async () => {
        await passOn("quiet-per-call");

        expect(liveAtReads(calls())).toStrictEqual(repeated(START_CALLS, 4 * PAIRS));
      });

      it("tears every state down by the end of the pass", async () => {
        await passOn("quiet-per-call");

        const log = calls();
        expect(count(log, " setup") - count(log, " teardown")).toBe(0);
      });

      it("runs each empty sample at its body sample's halved count", async () => {
        const probe = {
          heapUsed: fakeHeap(0),
          detector: fakeDetector((bodyCalls, nth) => bodyCalls === START_CALLS && nth === 0),
        };

        await passOn("quiet-per-call", probe);

        expect(liveAtReads(calls()).slice(-4 * PAIRS)).toStrictEqual(
          repeated(START_CALLS / 2, 4 * PAIRS),
        );
      });
    });

    describe("when no sample is flagged", () => {
      it("reads the paired difference per call, signed, below 0 when the deltas are below the empty sample's", async () => {
        const probe = { heapUsed: fakeHeap(0, () => 512), detector: fakeDetector() };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({ memory: { stats: { median: -8 } } });
      });

      it("summarizes every pair's difference per call", async () => {
        const probe = {
          heapUsed: fakeHeap(40, (emptyIndex) => emptyIndex * START_CALLS),
          detector: fakeDetector(),
        };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: {
            stats: { min: 20, median: 30, max: 40, sampleCount: PAIRS },
            sampling: { callsPerSample: START_CALLS },
          },
        });
      });
    });

    describe("when the detector flags a sample", () => {
      it.each([
        {
          why: "the first pair at 64 calls is flagged",
          flags: (bodyCalls: number, nth: number) => bodyCalls === START_CALLS && nth === 0,
          callsPerSample: 32,
        },
        {
          why: "the first pair at every count above 1 is flagged",
          flags: (bodyCalls: number, nth: number) => bodyCalls > 1 && nth === 0,
          callsPerSample: 1,
        },
      ])("halves the calls per sample when $why", async ({ flags, callsPerSample }) => {
        const probe = { heapUsed: fakeHeap(40), detector: fakeDetector(flags) };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: { stats: { median: 40, sampleCount: PAIRS }, sampling: { callsPerSample } },
        });
      });

      it("halves the calls per sample when the empty sample of a pair is flagged", async () => {
        const probe = {
          heapUsed: fakeHeap(40),
          detector: fakeDetector(undefined, (nth) => nth === 0),
        };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: { stats: { sampleCount: PAIRS }, sampling: { callsPerSample: START_CALLS / 2 } },
        });
      });

      it("discards the pairs kept at a count when a later pair at it is flagged", async () => {
        const probe = {
          heapUsed: fakeHeap(40, () => 640),
          detector: fakeDetector((bodyCalls, nth) => bodyCalls === START_CALLS && nth === 12),
        };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: {
            stats: { min: 20, max: 20, sampleCount: PAIRS },
            sampling: { callsPerSample: START_CALLS / 2 },
          },
        });
      });

      it.each([
        {
          why: "the first 21 pairs at one call are flagged",
          flaggedAtOne: (nth: number) => nth < 21,
          kept: 21,
        },
        {
          why: "22 pairs at one call are flagged after 5 clean ones",
          flaggedAtOne: (nth: number) => nth >= 5 && nth < 27,
          kept: 5,
        },
      ])("keeps $kept pairs when $why, taking at most 21 again", async ({ flaggedAtOne, kept }) => {
        const flags = (bodyCalls: number, nth: number): boolean =>
          bodyCalls > 1 ? nth === 0 : flaggedAtOne(nth);
        const probe = { heapUsed: fakeHeap(40), detector: fakeDetector(flags) };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: { stats: { median: 40, sampleCount: kept }, sampling: { callsPerSample: 1 } },
        });
      });

      it("reads null statistics when every pair at one call is flagged", async () => {
        const probe = { heapUsed: fakeHeap(40), detector: fakeDetector(() => true) };

        const result = await passOn("quiet", probe);

        expect(result).toStrictEqual({
          status: "ok",
          time: null,
          memory: { stats: null, sampling: { callsPerSample: 1 }, rawSamples: null },
        });
      });
    });

    describe("when the case fails during the pass", () => {
      it.each([
        {
          why: "a per-call setup throws after its first call",
          id: "second-setup-throws-per-call",
          error: { phase: "setup", message: "plum" },
        },
        {
          why: "a per-call teardown throws",
          id: "teardown-throws-per-call",
          error: { phase: "teardown", message: "pear" },
        },
        {
          why: "a per-call fn and teardown throw, fn's error winning over the teardown's",
          id: "fn-and-teardown-throw-per-call",
          error: { phase: "fn", message: "lemon", teardownError: { message: "mango" } },
        },
      ])("fails in the callback's phase when $why", async ({ id, error }) => {
        const result = await passOn(id);

        expect(result).toMatchObject({ status: "failed", error });
      });

      it("tears down every state left alive when fn throws inside a sample", async () => {
        const result = await passOn("third-fn-throws-per-call");

        const log = calls();
        expect({
          result,
          alive: count(log, " setup") - count(log, " teardown"),
        }).toMatchObject({ result: { status: "failed", error: { phase: "fn" } }, alive: 0 });
      });

      it("fails in phase child when the collection detector cannot be loaded", async () => {
        const probe = {
          heapUsed: fakeHeap(0),
          detector: async () => {
            throw new Error("apricot");
          },
        };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          status: "failed",
          error: { phase: "child", message: "apricot" },
        });
      });
    });
  });
});

describe("runOnce", () => {
  describe("when the id does not select exactly one case", () => {
    it("fails in phase load naming an id registered more than once", async () => {
      const result = await runOnce(fixture("duplicate.ts"), "apple");

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "load", message: expect.stringContaining("apple") },
      });
    });
  });

  describe("when the case runs", () => {
    it("calls the selected case's setup, fn, then teardown once, no other case's", async () => {
      const result = await runOnce(LIFECYCLE, "quiet");

      expect(result.status).toBe("ok");
      expect(calls()).toStrictEqual(["quiet setup", "quiet fn", "quiet teardown"]);
    });

    it("runs the contender its id names, no other contender", async () => {
      await runOnce(CONTEST, "sort/merge");

      expect(calls()).toStrictEqual(["merge fn"]);
    });
  });
});

// ---------------------------------------------------------------------------
// The child started as a process
// ---------------------------------------------------------------------------

const CHILD = fileURLToPath(new URL("../src/child.ts", import.meta.url));

/** The bytes the `loud.ts` fixture prints to each stream, its newline included. */
const LOUD_STREAM_BYTES = 1024 * 1024;

const LOUD = fixture("loud.ts");

/** The node flags the child entry needs: an exposed collector and tsx to load TypeScript. */
const NODE_ARGS = ["--expose-gc", "--import", "tsx"];

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly fd3: string;
}

/** Starts the child entry on node with `request` as JSON and gathers its exit and output. */
async function spawnChild(request: object): Promise<ChildRun> {
  const child = spawn(process.execPath, [...NODE_ARGS, CHILD, JSON.stringify(request)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: KILL_AFTER_MS,
  });
  const [, stdout, stderr, fd3] = child.stdio;
  if (!(stdout instanceof Readable && stderr instanceof Readable && fd3 instanceof Readable)) {
    throw new Error("the child's stdout, stderr and fd 3 are not all readable pipes");
  }

  const [out, err, result, [status]] = await Promise.all([
    text(stdout),
    text(stderr),
    text(fd3),
    once(child, "close"),
  ]);

  return {
    status: typeof status === "number" ? status : null,
    stdout: out,
    stderr: err,
    fd3: result,
  };
}

/** A request to time the case `id` of the `memory.ts` fixture, then read its memory. */
function measuringMemory(id: string): object {
  return {
    mode: "measure",
    file: fixture("memory.ts"),
    id,
    ...SHORT_RUN,
    time: true,
    memory: true,
  };
}

/** The median of a child result's memory statistics; throws when the result holds none. */
function memoryMedian(result: unknown): number {
  const median = property(property(property(result, "memory"), "stats"), "median");
  if (typeof median !== "number") {
    throw new Error(`no memory median in ${JSON.stringify(result).slice(0, 400)}`);
  }
  return median;
}

/** The JSON of the one newline-terminated line `fd3` holds; throws when it holds anything else. */
function resultLine(fd3: string): unknown {
  const line = /^([^\n]*)\n$/.exec(fd3)?.[1];
  if (line === undefined)
    throw new Error(`fd 3 holds no single result line: ${JSON.stringify(fd3.slice(0, 200))}`);
  return JSON.parse(line);
}

describe("the child started on node", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when the file leaves an interval open", () => {
    it("exits 0 after the result line", async () => {
      const run = await spawnChild({
        mode: "list",
        file: fixture("open-interval.ts"),
      });

      expect(run.status).toBe(0);
      expect(resultLine(run.fd3)).toStrictEqual({
        status: "ok",
        cases: [{ id: "orange", setupPerCall: false, name: "orange", contender: null }],
      });
    });
  });

  describe("when the file prints a megabyte to stdout and stderr", () => {
    it("hands the parent every byte", async () => {
      const run = await spawnChild({ mode: "list", file: LOUD });

      expect({
        stdout: run.stdout === `${"o".repeat(LOUD_STREAM_BYTES - 1)}\n`,
        stderr: run.stderr === `${"e".repeat(LOUD_STREAM_BYTES - 1)}\n`,
      }).toStrictEqual({ stdout: true, stderr: true });
    });
  });

  describe("when the file's name holds a hash", () => {
    it("imports it by its file URL", async () => {
      const run = await spawnChild({ mode: "list", file: fixture("hash#name.ts") });

      expect(resultLine(run.fd3)).toStrictEqual({
        status: "ok",
        cases: [{ id: "found", setupPerCall: false, name: "found", contender: null }],
      });
    });
  });

  describe("when a measure request asks time and memory", () => {
    it.each([
      { id: "zero", bytes: 0, within: 0 },
      { id: "object", bytes: 40, within: 1 },
      { id: "zero-per-call", bytes: 0, within: 0 },
      { id: "object-per-call", bytes: 40, within: 1 },
    ])(
      "reads $id at $bytes bytes per call, within $within, after timing",
      async ({ id, bytes, within }) => {
        const run = await spawnChild(measuringMemory(id));

        expect(Math.abs(memoryMedian(resultLine(run.fd3)) - bytes)).toBeLessThanOrEqual(within);
      },
    );

    // Without the collection forced before each sample, a collection lands inside the samples
    // of this body and the pass halves its calls per sample. That holds only while V8's young
    // generation is small: at `--min-semi-space-size=16` the reading stays at 64 without the
    // forced collection. Capping the semi-space at 1 MB keeps it small whatever size a Node
    // release starts with, so the test keeps catching a removed collection.
    it("reads a body allocating a 1024-element array per call at 64 calls per sample", async () => {
      vi.stubEnv("NODE_OPTIONS", "--max-semi-space-size=1");

      const run = await spawnChild(measuringMemory("array"));

      expect(resultLine(run.fd3)).toMatchObject({
        status: "ok",
        memory: { sampling: { callsPerSample: 64 } },
      });
    });

    describe("when every call collects", () => {
      it("halves to one call per sample", async () => {
        const run = await spawnChild(measuringMemory("collect"));

        expect(resultLine(run.fd3)).toMatchObject({
          status: "ok",
          memory: { sampling: { callsPerSample: 1 } },
        });
      });

      it("reads null statistics", async () => {
        const run = await spawnChild(measuringMemory("collect"));

        expect(resultLine(run.fd3)).toMatchObject({ status: "ok", memory: { stats: null } });
      });
    });
  });

  describe("when the case fails", () => {
    it("writes the failed result of a once request", async () => {
      const run = await spawnChild({ mode: "once", file: LIFECYCLE, id: "fn-throws" });

      expect(resultLine(run.fd3)).toMatchObject({
        status: "failed",
        error: { phase: "fn", message: "kiwi" },
      });
    });
  });
});
