import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  failedResult,
  listCases,
  measureCase,
  parseRequest,
  runOnce,
  type ChildResult,
} from "../src/child.js";
import { MeasureError } from "../src/measure/measure.js";
import { exposedGc } from "./measure/fixtures.js";
import { requiresRealBunHere } from "./real-bun.js";

const REGISTRY = Symbol.for("repset.registry");

/** The slot where the `lifecycle.ts` fixture records each callback it runs. */
const CALLS = Symbol.for("repset.child-calls");

const FIXTURES = fileURLToPath(new URL("fixtures/child/", import.meta.url));

/** The absolute path of the child fixture `name`. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

/** The phase of a failed result, or `undefined` for a successful one. */
function phaseOf(result: ChildResult): string | undefined {
  return result.status === "failed" ? result.error.phase : undefined;
}

const FILE = fixture("three-cases.ts");

const MEASURE_REQUEST = { mode: "measure", file: FILE, id: "alpha", minTime: 5, minSamples: 8 };

const LIFECYCLE = fixture("lifecycle.ts");

/** The callbacks the `lifecycle.ts` fixture recorded since the test began. */
function calls(): unknown[] {
  const recorded: unknown = Reflect.get(globalThis, CALLS);
  if (!Array.isArray(recorded)) throw new Error("no call list installed");
  return recorded;
}

/** Measures `id` of `file` with a short run. */
async function measureShort(file: string, id: string): Promise<ChildResult> {
  return measureCase(file, id, { minTime: 5, minSamples: 8 });
}

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, REGISTRY);
  Reflect.set(globalThis, CALLS, []);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, CALLS);
});

describe("parseRequest", () => {
  describe("when the request is complete", () => {
    it.each([
      { request: { mode: "list", file: FILE } },
      { request: { mode: "once", file: FILE, id: "alpha" } },
      { request: MEASURE_REQUEST },
    ])("returns the $request.mode request", ({ request }) => {
      const parsed = parseRequest(JSON.stringify(request));

      expect(parsed).toStrictEqual(request);
    });
  });

  describe("when the request is malformed", () => {
    it.each([
      { why: "not JSON", error: /JSON/, argument: "banana" },
      { why: "not an object", error: /JSON object/, argument: "3" },
      { why: "null", error: /JSON object/, argument: "null" },
      {
        why: "an unknown mode",
        error: /mode/,
        argument: JSON.stringify({ mode: "walk", file: FILE }),
      },
      { why: "no mode", error: /mode/, argument: JSON.stringify({ file: FILE }) },
      { why: "no file", error: /file/, argument: JSON.stringify({ mode: "list" }) },
      {
        why: "a file that is not a string",
        error: /file/,
        argument: JSON.stringify({ mode: "list", file: 7 }),
      },
      {
        why: "a relative file",
        error: /absolute path/,
        argument: JSON.stringify({ mode: "list", file: "bench/sort.ts" }),
      },
      {
        why: "once without an id",
        error: /\bid\b/,
        argument: JSON.stringify({ mode: "once", file: FILE }),
      },
      {
        why: "once with an id that is not a string",
        error: /\bid\b/,
        argument: JSON.stringify({ mode: "once", file: FILE, id: 1 }),
      },
      {
        why: "measure without an id",
        error: /\bid\b/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, id: undefined }),
      },
      {
        why: "measure without minTime",
        error: /minTime/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, minTime: undefined }),
      },
      {
        why: "measure without minSamples",
        error: /minSamples/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, minSamples: undefined }),
      },
      {
        why: "measure with a minTime that is not a number",
        error: /minTime/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, minTime: "5" }),
      },
      {
        why: "measure with a minSamples that is not a number",
        error: /minSamples/,
        argument: JSON.stringify({ ...MEASURE_REQUEST, minSamples: "8" }),
      },
    ])("throws for $why", ({ argument, error }) => {
      expect(() => parseRequest(argument)).toThrow(error);
    });
  });
});

describe("listCases", () => {
  describe("when the file registers cases", () => {
    it("returns each case's id and setupPerCall in registration order", async () => {
      const result = await listCases(FILE);

      expect(result).toStrictEqual({
        status: "ok",
        cases: [
          { id: "alpha", setupPerCall: false },
          { id: "beta", setupPerCall: true },
          { id: "gamma", setupPerCall: false },
        ],
      });
    });

    it("lists an id registered twice twice", async () => {
      const result = await listCases(fixture("duplicate.ts"));

      expect(result).toStrictEqual({
        status: "ok",
        cases: [
          { id: "apple", setupPerCall: false },
          { id: "apple", setupPerCall: false },
        ],
      });
    });

    it("lists the cases registered after a top-level await", async () => {
      const result = await listCases(fixture("top-level-await.ts"));

      expect(result).toStrictEqual({ status: "ok", cases: [{ id: "late", setupPerCall: false }] });
    });
  });

  describe("when the file registers nothing", () => {
    it("returns an empty list", async () => {
      const result = await listCases(fixture("empty.ts"));

      expect(result).toStrictEqual({ status: "ok", cases: [] });
    });
  });

  describe("when the file fails to load", () => {
    it.each([
      { why: "is missing", name: "absent.ts" },
      { why: "throws at its top level", name: "top-level-throw.ts" },
      { why: "makes a bench() call that is rejected", name: "registration-error.ts" },
    ])("fails in phase load when the file $why", async ({ name }) => {
      const result = await listCases(fixture(name));

      expect(phaseOf(result)).toBe("load");
    });

    it("carries the message of what the file threw", async () => {
      const result = await listCases(fixture("top-level-throw.ts"));

      expect(result.status === "failed" && result.error.message).toBe("banana");
    });
  });
});

describe("failedResult", () => {
  describe("when the cause is an Error", () => {
    it("carries the phase, its message and its own stack", () => {
      const cause = new Error("plum");

      const result = failedResult("setup", cause);

      expect(result).toStrictEqual({
        status: "failed",
        error: { phase: "setup", message: "plum", stack: cause.stack },
      });
    });

    it("carries a null stack when its stack is not a string", () => {
      const cause = new Error("plum");
      Object.defineProperty(cause, "stack", { value: 42 });

      const result = failedResult("fn", cause);

      expect(result.error.stack).toBeNull();
    });
  });

  describe("when the cause is not an Error", () => {
    it("carries its string form and a null stack", () => {
      const result = failedResult("teardown", "pear");

      expect(result).toStrictEqual({
        status: "failed",
        error: { phase: "teardown", message: "pear", stack: null },
      });
    });

    it("carries the message MeasureError gives a value with no string form", () => {
      const unprintable: unknown = Object.create(null);

      const result = failedResult("load", unprintable);

      expect(result.error).toStrictEqual({
        phase: "load",
        message: new MeasureError("fn", unprintable).message,
        stack: null,
      });
    });
  });

  describe("when the cause is a MeasureError", () => {
    it("carries its phase, its message and the stack of its cause", () => {
      const inner = new Error("grape");
      const error = new MeasureError("calibration", inner);

      const result = failedResult("load", error);

      expect(result.error).toStrictEqual({
        phase: "calibration",
        message: "grape",
        stack: inner.stack,
      });
    });

    it("carries a null stack when its cause is not an Error", () => {
      const error = new MeasureError("fn", "melon");

      const result = failedResult("load", error);

      expect(result.error).toStrictEqual({ phase: "fn", message: "melon", stack: null });
    });
  });
});

describe("measureCase and runOnce", () => {
  const MODES = [
    { mode: "measure", run: measureShort },
    { mode: "once", run: runOnce },
  ];

  describe("when the id does not select exactly one case", () => {
    it.each(MODES)(
      "$mode fails in phase load naming an id that is not registered",
      async ({ run }) => {
        const result = await run(FILE, "banana");

        expect(result).toMatchObject({
          status: "failed",
          error: { phase: "load", message: expect.stringContaining("banana") },
        });
      },
    );

    it.each(MODES)(
      "$mode fails in phase load naming an id registered more than once",
      async ({ run }) => {
        const result = await run(fixture("duplicate.ts"), "apple");

        expect(result).toMatchObject({
          status: "failed",
          error: { phase: "load", message: expect.stringContaining("apple") },
        });
      },
    );
  });

  describe("when the file fails to load", () => {
    it.each(MODES)("$mode fails in phase load", async ({ run }) => {
      const result = await run(fixture("top-level-throw.ts"), "alpha");

      expect(phaseOf(result)).toBe("load");
    });
  });
});

describe("measureCase", () => {
  describe("when the case measures", () => {
    it("returns the report's per-process fields", { timeout: 15_000 }, async () => {
      vi.stubGlobal("gc", exposedGc());

      const result = await measureShort(LIFECYCLE, "steady");

      expect(result).toStrictEqual({
        status: "ok",
        stats: {
          min: expect.any(Number),
          p25: expect.any(Number),
          median: expect.any(Number),
          p75: expect.any(Number),
          p99: expect.any(Number),
          max: expect.any(Number),
          mean: expect.any(Number),
          sampleCount: expect.any(Number),
        },
        sampling: {
          timerResolutionNs: expect.any(Number),
          callsPerSample: expect.any(Number),
          callsPerSampleFixed: false,
          warmupSamples: expect.any(Number),
          timingAttempts: expect.any(Number),
          timingMs: expect.any(Number),
        },
        checks: { ratioToEmptyBody: expect.any(Number) },
        gc: {
          count: expect.any(Number),
          minor: expect.any(Number),
          major: expect.any(Number),
          totalMs: expect.any(Number),
          maxMs: expect.any(Number),
        },
      });
    });

    it("reports the quantiles under their own names", { timeout: 15_000 }, async () => {
      vi.stubGlobal("gc", exposedGc());

      const result = await measureShort(LIFECYCLE, "steady");

      const stats = result.status === "ok" && "stats" in result ? result.stats : undefined;
      const quantiles = [stats?.min, stats?.p25, stats?.median, stats?.p75, stats?.p99, stats?.max];
      expect(quantiles).toStrictEqual(quantiles.toSorted((a = 0, b = 0) => a - b));
    });

    it("samples for the request's minTime and minSamples", { timeout: 15_000 }, async () => {
      vi.stubGlobal("gc", exposedGc());

      const result = await measureCase(LIFECYCLE, "steady", { minTime: 0, minSamples: 200 });

      expect(result).toMatchObject({
        stats: { sampleCount: expect.toSatisfy((count: number) => count >= 200) },
        sampling: { timingMs: expect.toSatisfy((ms: number) => ms < 1000) },
      });
    });

    it("runs none of the file's other cases", { timeout: 15_000 }, async () => {
      vi.stubGlobal("gc", exposedGc());

      const result = await measureShort(LIFECYCLE, "steady");

      expect(result.status).toBe("ok");
      expect(calls()).toStrictEqual([]);
    });
  });

  describe("when measure rejects", () => {
    it("carries the phase, the message and the stack of what the case threw", async () => {
      vi.stubGlobal("gc", exposedGc());

      const result = await measureShort(LIFECYCLE, "fn-throws");

      const [thrown] = calls();
      expect(thrown).toBeInstanceOf(Error);
      expect(result).toStrictEqual({
        status: "failed",
        error: {
          phase: "fn",
          message: "kiwi",
          stack: thrown instanceof Error ? thrown.stack : undefined,
        },
      });
    });
  });
});

describe("runOnce", () => {
  describe("when the case runs", () => {
    it("returns a success with no measurement when no collector is exposed", async () => {
      vi.stubGlobal("gc", undefined);

      const result = await runOnce(LIFECYCLE, "quiet");

      expect(result).toStrictEqual({ status: "ok" });
    });

    it.each([
      { kind: "shared-state", id: "quiet" },
      { kind: "setupPerCall", id: "batch" },
    ])(
      "runs one setup, one fn and one teardown of a $kind case, and no other case",
      async ({ id }) => {
        const result = await runOnce(LIFECYCLE, id);

        expect(result.status).toBe("ok");
        expect(calls()).toStrictEqual([`${id} setup`, `${id} fn`, `${id} teardown`]);
      },
    );
  });

  describe("when a callback fails", () => {
    it.each([
      { why: "setup throws", id: "setup-throws", phase: "setup", message: "fig", recorded: [] },
      {
        why: "fn throws",
        id: "fn-throws",
        phase: "fn",
        message: "kiwi",
        recorded: [expect.any(Error), "fn-throws teardown"],
      },
      {
        why: "fn returns a thenable",
        id: "fn-returns-thenable",
        phase: "fn",
        message: expect.any(String),
        recorded: ["fn-returns-thenable teardown"],
      },
      {
        why: "fn throws, then teardown throws",
        id: "fn-and-teardown-throw",
        phase: "fn",
        message: "lime",
        recorded: [],
      },
      {
        why: "teardown throws after fn ran",
        id: "teardown-throws",
        phase: "teardown",
        message: "pear",
        recorded: [],
      },
    ])("fails in phase $phase when $why", async ({ id, phase, message, recorded }) => {
      const result = await runOnce(LIFECYCLE, id);

      expect(result).toMatchObject({ status: "failed", error: { phase, message } });
      expect(calls()).toStrictEqual(recorded);
    });
  });
});

// ---------------------------------------------------------------------------
// The child started as a process
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const CHILD = fileURLToPath(new URL("../src/child.ts", import.meta.url));

/** A runtime and tsx starting, then a short measurement, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long a child may run before it is killed, so one that never exits fails instead of hanging. */
const KILL_AFTER_MS = 30_000;

/** The bytes the `loud.ts` fixture prints to each stream, its newline included. */
const MIB = 1024 * 1024;

const LOUD = fixture("loud.ts");

const RUNTIMES = {
  node: { command: process.execPath, args: ["--expose-gc", "--import", "tsx"] },
  bun: { command: "bun", args: ["--expose-gc"] },
} as const;

type Runtime = keyof typeof RUNTIMES;

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly fd3: string;
}

/** Gathers every chunk `stream` emits; the list fills as the stream flows. */
function chunksOf(stream: EventEmitter | null | undefined): Buffer[] {
  const chunks: Buffer[] = [];
  stream?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return chunks;
}

/**
 * Starts the child entry on `runtime` with `request` as its argument, file descriptor 3 a pipe.
 *
 * @param runtime - The runtime the child runs on.
 * @param request - The request, serialized to JSON unless it is already a string.
 * @returns The exit status and what the child wrote to stdout, stderr and file descriptor 3.
 * @throws Error when the runtime cannot be spawned.
 */
async function spawnChild(runtime: Runtime, request: unknown): Promise<ChildRun> {
  const { command, args } = RUNTIMES[runtime];
  const argument = typeof request === "string" ? request : JSON.stringify(request);
  const child = spawn(command, [...args, CHILD, argument], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: KILL_AFTER_MS,
  });
  const [stdout, stderr, fd3] = [child.stdio[1], child.stdio[2], child.stdio[3]].map(chunksOf);

  const [status]: unknown[] = await once(child, "close");

  const text = (chunks: Buffer[] = []): string => Buffer.concat(chunks).toString("utf8");
  return {
    status: typeof status === "number" ? status : null,
    stdout: text(stdout),
    stderr: text(stderr),
    fd3: text(fd3),
  };
}

/** The JSON of the one newline-terminated line `fd3` holds; throws when it holds anything else. */
function resultLine(fd3: string): unknown {
  const line = /^([^\n]*)\n$/.exec(fd3)?.[1];
  if (line === undefined)
    throw new Error(`fd 3 holds no single result line: ${JSON.stringify(fd3.slice(0, 200))}`);
  return JSON.parse(line);
}

describe.each([
  { runtime: "node", here: true, gc: expect.objectContaining({ count: expect.any(Number) }) },
  { runtime: "bun", here: requiresRealBunHere(), gc: null },
] as const)("the child started on $runtime", ({ runtime, here, gc }) => {
  describe.runIf(here)("when the request is valid", () => {
    it(
      "writes the file's cases as one result line on fd 3 and exits 0",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const run = await spawnChild(runtime, { mode: "list", file: FILE });

        expect(run.status).toBe(0);
        expect(resultLine(run.fd3)).toStrictEqual({
          status: "ok",
          cases: [
            { id: "alpha", setupPerCall: false },
            { id: "beta", setupPerCall: true },
            { id: "gamma", setupPerCall: false },
          ],
        });
      },
    );

    it("writes the measurement of the requested case", { timeout: SPAWN_TIMEOUT_MS }, async () => {
      const run = await spawnChild(runtime, { ...MEASURE_REQUEST, file: LIFECYCLE, id: "steady" });

      expect(resultLine(run.fd3)).toMatchObject({
        status: "ok",
        stats: { sampleCount: expect.any(Number) },
        gc,
      });
    });

    it(
      "exits 0 after the result line when the file leaves an interval open",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const run = await spawnChild(runtime, { mode: "list", file: fixture("open-interval.ts") });

        expect(run.status).toBe(0);
        expect(resultLine(run.fd3)).toStrictEqual({
          status: "ok",
          cases: [{ id: "orange", setupPerCall: false }],
        });
      },
    );

    it(
      "keeps what the file prints out of the result line",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const run = await spawnChild(runtime, { mode: "list", file: LOUD });

        expect(run.status).toBe(0);
        expect(resultLine(run.fd3)).toStrictEqual({
          status: "ok",
          cases: [{ id: "loud", setupPerCall: false }],
        });
      },
    );
  });
});

describe("the child started on node", () => {
  it(
    "hands the parent every byte the file printed to stdout and stderr",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const run = await spawnChild("node", { mode: "list", file: LOUD });

      expect({
        stdout: run.stdout === `${"o".repeat(MIB - 1)}\n`,
        stderr: run.stderr === `${"e".repeat(MIB - 1)}\n`,
      }).toStrictEqual({ stdout: true, stderr: true });
    },
  );

  it(
    "imports a file whose name holds a hash by its file URL",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const run = await spawnChild("node", { mode: "list", file: fixture("hash#name.ts") });

      expect(resultLine(run.fd3)).toStrictEqual({
        status: "ok",
        cases: [{ id: "found", setupPerCall: false }],
      });
    },
  );

  describe("when the request is malformed", () => {
    it(
      "exits non-zero before loading the file, writing nothing on fd 3",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const run = await spawnChild("node", { mode: "once", file: LOUD });

        expect(run.status).not.toBe(0);
        expect(run.fd3).toBe("");
        expect(run.stdout).toBe("");
        expect(run.stderr).toMatch(/\bid\b/);
      },
    );
  });

  describe("when the case fails", () => {
    it("writes the failed result and exits 0", { timeout: SPAWN_TIMEOUT_MS }, async () => {
      const run = await spawnChild("node", { mode: "once", file: LIFECYCLE, id: "fn-throws" });

      expect(run.status).toBe(0);
      expect(resultLine(run.fd3)).toMatchObject({
        status: "failed",
        error: { phase: "fn", message: "kiwi" },
      });
    });
  });
});
