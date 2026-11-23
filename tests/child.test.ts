import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ChildResult, parseRequest } from "../src/child-protocol.js";
import {
  listCases,
  measureCase,
  runOnce,
  type CollectionDetector,
  type MemoryProbe,
} from "../src/child.js";
import { fixturePath } from "./fixture-path.js";
import { enabledGc } from "./measure/fixtures.js";
import { resetRegistry } from "./registry.js";
import { KILL_AFTER_MS, SPAWN_TIMEOUT_MS } from "./spawn-limits.js";

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
    it.each([
      { why: "a list request", request: { mode: "list", file: FILE } },
      { why: "a once request", request: { mode: "once", file: FILE, id: "alpha" } },
      { why: "a measure request", request: MEASURE_REQUEST },
      {
        why: "a measure request with its calls per sample",
        request: { ...MEASURE_REQUEST, callsPerSample: 200 },
      },
      {
        why: "a measure request for memory alone",
        request: { ...MEASURE_REQUEST, time: false, memory: true },
      },
    ])("returns $why", ({ request }) => {
      const parsed = parseRequest(JSON.stringify(request));

      expect(parsed).toStrictEqual(request);
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
        why: "a null id",
        error: /\bid\b.*\bnull\b/,
        argument: JSON.stringify({ mode: "once", file: FILE, id: null }),
      },
      {
        why: "a minTime that is a string",
        error: /\bminTime\b.*"5"/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, minTime: "5" }),
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
      {
        why: "a memory that is not a boolean",
        error: /\bmemory\b.*"yes"/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, memory: "yes" }),
      },
    ])("throws a TypeError for $why", ({ argument, error }) => {
      const parse = (): unknown => parseRequest(argument);

      expect(parse).toThrow(TypeError);
      expect(parse).toThrow(error);
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
    it("fails in phase load with the message and stack of the Error the file threw", async () => {
      const result = await listCases(fixture("top-level-throw.ts"));

      expect(result).toStrictEqual({
        status: "failed",
        error: {
          phase: "load",
          message: "banana",
          stack: expect.stringMatching(/^Error: banana\n/u),
          teardownError: null,
        },
      });
    });

    it("fails in phase load when the file throws a value whose instanceof check throws", async () => {
      const result = await listCases(fixture("top-level-trapped-proxy.ts"));

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "load", teardownError: null },
      });
    });
  });
});

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

  describe("when measure rejects", () => {
    it("fails in the phase of what the case threw", async () => {
      const result = await measureShort(LIFECYCLE, "fn-throws");

      expect(result).toMatchObject({ status: "failed", error: { phase: "fn" } });
    });
  });
});

// ---------------------------------------------------------------------------
// The memory pass, read through a fake heap and a fake collection detector
// ---------------------------------------------------------------------------

/** What the fake heap records in the call list at each reading. */
const READ = "read";

/** What the fake collector records in the call list at each forced collection. */
const GC = "gc";

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

/** The entries before each sample's first heap reading, since the previous sample's second. */
function gapsBeforeSamples(log: readonly unknown[]): unknown[][] {
  const reads = readIndices(log);
  return reads.flatMap((read, index) =>
    index % 2 === 0 ? [log.slice(index === 0 ? 0 : (reads[index - 1] ?? 0) + 1, read)] : [],
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

/** `n` copies of `value`. */
function repeated<T>(n: number, value: T): T[] {
  return Array.from({ length: n }, () => value);
}

describe("measureCase with memory asked", { timeout: MEASURE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubGlobal("gc", () => {
      calls().push(GC);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    it("returns the timing's failure and reads no heap when the timing fails", async () => {
      const result = await measureCase(
        LIFECYCLE,
        "fn-throws",
        { ...TIME_ONLY, memory: true },
        cleanProbe(),
      );

      expect(result).toMatchObject({ status: "failed", error: { phase: "fn", message: "kiwi" } });
      expect(calls()).not.toContain(READ);
    });
  });

  describe("when time alone is asked", () => {
    it("returns a null memory and reads no heap", async () => {
      const result = await measureCase(LIFECYCLE, "steady", TIME_ONLY, cleanProbe());

      expect(result).toMatchObject({ status: "ok", memory: null });
      expect(calls()).not.toContain(READ);
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
    it("returns a null memory and reads no heap", async () => {
      vi.stubGlobal("Bun", {});

      const result = await passOn("quiet");

      expect(result).toStrictEqual({ status: "ok", time: null, memory: null });
      expect(calls()).not.toContain(READ);
    });
  });
});

describe("the memory pass", { timeout: MEASURE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubGlobal("gc", () => {
      calls().push(GC);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("when the case shares one state", () => {
    it("builds the state before the first heap reading and tears it down once after the last", async () => {
      await passOn("quiet");

      const log = calls();
      const firstRead = log.indexOf(READ);
      const lastRead = log.lastIndexOf(READ);
      expect({
        setupsBefore: count(log.slice(0, firstRead), " setup"),
        tornDownAfter: count(log.slice(lastRead), " teardown"),
        between:
          count(log.slice(firstRead, lastRead), " setup") +
          count(log.slice(firstRead, lastRead), " teardown"),
      }).toStrictEqual({ setupsBefore: 1, tornDownAfter: 1, between: 0 });
    });

    it("takes 21 pairs of a 64-call body sample and an empty sample", async () => {
      await passOn("quiet");

      const bodyCalls = samples(calls()).map((sample) => count(sample, " fn"));
      expect(bodyCalls.toSorted((a, b) => a - b)).toStrictEqual([
        ...repeated(PAIRS, 0),
        ...repeated(PAIRS, START_CALLS),
      ]);
    });

    it("forces a collection before each sample's first heap reading and none between its two", async () => {
      await passOn("quiet");

      const log = calls();
      expect({
        before: gapsBeforeSamples(log).map((gap) => gap.includes(GC)),
        inside: samples(log).some((sample) => sample.includes(GC)),
      }).toStrictEqual({ before: repeated(2 * PAIRS, true), inside: false });
    });
  });

  describe("when the case builds a state per call", () => {
    it("holds as many states at each heap reading as the sample's calls, and none after", async () => {
      await passOn("quiet-per-call");

      const log = calls();
      expect({
        atReads: liveAtReads(log),
        atEnd: count(log, " setup") - count(log, " teardown"),
      }).toStrictEqual({ atReads: repeated(4 * PAIRS, START_CALLS), atEnd: 0 });
    });

    it("runs each empty sample at its body sample's halved count", async () => {
      const probe = {
        heapUsed: fakeHeap(0),
        detector: fakeDetector((bodyCalls, nth) => bodyCalls === START_CALLS && nth === 0),
      };

      await passOn("quiet-per-call", probe);

      expect(liveAtReads(calls()).slice(-4 * PAIRS)).toStrictEqual(
        repeated(4 * PAIRS, START_CALLS / 2),
      );
    });
  });

  describe("when no sample is flagged", () => {
    it.each([
      {
        why: "deltas equal to the empty sample's read 0",
        bytesPerCall: 4.5,
        emptyBytes: 288,
        median: 0,
      },
      {
        why: "deltas below the empty sample's read below 0",
        bytesPerCall: 0,
        emptyBytes: 512,
        median: -8,
      },
    ])(
      "reads the paired difference per call, signed: $why",
      async ({ bytesPerCall, emptyBytes, median }) => {
        const probe = {
          heapUsed: fakeHeap(bytesPerCall, () => emptyBytes),
          detector: fakeDetector(),
        };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({ memory: { stats: { median } } });
      },
    );

    it("summarizes every pair's difference per call", async () => {
      const probe = {
        heapUsed: fakeHeap(40, (emptyIndex) => emptyIndex * START_CALLS),
        detector: fakeDetector(),
      };

      const result = await passOn("quiet", probe);

      expect(result).toMatchObject({
        memory: {
          stats: {
            min: 20,
            p25: 25,
            median: 30,
            p75: 35,
            p99: expect.closeTo(39.8, 9),
            max: 40,
            mean: 30,
            sampleCount: PAIRS,
          },
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
        why: "the third pair at 64 calls is flagged, discarding the two kept",
        flags: (bodyCalls: number, nth: number) => bodyCalls === START_CALLS && nth === 2,
        callsPerSample: 32,
      },
      {
        why: "the first pair at every count above 1 is flagged",
        flags: (bodyCalls: number, nth: number) => bodyCalls > 1 && nth === 0,
        callsPerSample: 1,
      },
    ])(
      "halves the calls per sample and takes 21 pairs again when $why",
      async ({ flags, callsPerSample }) => {
        const probe = { heapUsed: fakeHeap(40), detector: fakeDetector(flags) };

        const result = await passOn("quiet", probe);

        expect(result).toMatchObject({
          memory: { stats: { median: 40, sampleCount: PAIRS }, sampling: { callsPerSample } },
        });
      },
    );

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
        why: "setup throws a value that is not an Error, kept as the cause",
        id: "setup-throws-string",
        error: { phase: "setup", message: "papaya", stack: null, teardownError: null },
      },
      {
        why: "fn throws, its error winning over the cleanup teardown's",
        id: "fn-and-teardown-throw",
        error: { phase: "fn", message: "lime", teardownError: { message: "melon" } },
      },
      {
        why: "teardown throws",
        id: "teardown-throws",
        error: { phase: "teardown", message: "fig" },
      },
      {
        why: "a per-call setup throws after its first call",
        id: "second-setup-throws-per-call",
        error: { phase: "setup", message: "plum" },
      },
      {
        why: "a per-call fn throws on its first call",
        id: "fn-throws-per-call",
        error: { phase: "fn", message: "cherry" },
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

    it("fails in phase child when the forced collection throws", async () => {
      vi.stubGlobal("gc", () => {
        throw new Error("quince");
      });

      const result = await passOn("quiet");

      expect(result).toMatchObject({
        status: "failed",
        error: { phase: "child", message: "quince" },
      });
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

  describe("when the case fails", () => {
    it("fails in the phase of the failure, with the stack of the Error the case threw", async () => {
      const result = await runOnce(LIFECYCLE, "fn-throws");

      expect(result).toStrictEqual({
        status: "failed",
        error: {
          phase: "fn",
          message: "kiwi",
          stack: expect.stringMatching(/^Error: kiwi\n/u),
          teardownError: null,
        },
      });
    });

    it("carries a cleanup teardown's failure as the message and stack of the Error it threw", async () => {
      const result = await runOnce(LIFECYCLE, "fn-and-teardown-throw");

      expect(result).toMatchObject({
        status: "failed",
        error: {
          phase: "fn",
          message: "lime",
          teardownError: { message: "melon", stack: expect.stringMatching(/^Error: melon\n/u) },
        },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The child started as a process
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../", import.meta.url));

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
