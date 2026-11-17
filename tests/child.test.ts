import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listCases, measureCase, parseRequest, runOnce, type ChildResult } from "../src/child.js";
import { enabledGc } from "./measure/fixtures.js";
import { resetRegistry } from "./registry.js";

/** The slot where the `lifecycle.ts` fixture records each callback it runs. */
const CALLS = Symbol.for("repset.child-calls");

const FIXTURES = fileURLToPath(new URL("fixtures/child/", import.meta.url));

/** The absolute path of the child fixture `name`. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

const FILE = fixture("three-cases.ts");

/** What `FILE` lists: its three cases in registration order. */
const FILE_LISTED = {
  status: "ok",
  cases: [
    { id: "alpha", setupPerCall: false },
    { id: "beta", setupPerCall: true },
    { id: "gamma", setupPerCall: false },
  ],
};

/** The sampling bounds of a short measurement. */
const SHORT_RUN = { minTime: 5, minSamples: 8 };

/** How long a short measurement may take on a slow CI runner. */
const MEASURE_TIMEOUT_MS = 15_000;

const MEASURE_REQUEST = { mode: "measure", file: FILE, id: "alpha", ...SHORT_RUN };

const LIFECYCLE = fixture("lifecycle.ts");

/** The callbacks the `lifecycle.ts` fixture recorded since the test began. */
function calls(): unknown[] {
  const recorded: unknown = Reflect.get(globalThis, CALLS);
  if (!Array.isArray(recorded)) throw new Error("no call list installed");
  return recorded;
}

/** Measures `id` of `file` with a short run. */
async function measureShort(file: string, id: string): Promise<ChildResult> {
  return measureCase(file, id, SHORT_RUN);
}

beforeEach(() => {
  vi.resetModules();
  resetRegistry();
  Reflect.set(globalThis, CALLS, []);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    ])("throws a TypeError for $why", ({ argument, error }) => {
      const parse = (): unknown => parseRequest(argument);

      expect(parse).toThrow(TypeError);
      expect(parse).toThrow(error);
    });
  });
});

describe("listCases", () => {
  describe("when the file registers cases", () => {
    it("returns each case's id and setupPerCall in registration order", async () => {
      const result = await listCases(FILE);

      expect(result).toStrictEqual(FILE_LISTED);
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
    it("returns the report's per-process fields, its quantiles under their own names", async () => {
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
        gc: expect.any(Object),
      });
      if (!("stats" in result)) throw new Error("unreachable: the shape above holds stats");
      const { min, p25, median, p75, p99, max } = result.stats;
      const quantiles = [min, p25, median, p75, p99, max];
      expect(quantiles).toStrictEqual(quantiles.toSorted((a, b) => a - b));
    });

    it("measures at the calls per sample it is given, reporting it as fixed", async () => {
      const result = await measureCase(LIFECYCLE, "steady", { ...SHORT_RUN, callsPerSample: 3 });

      expect(result).toMatchObject({
        status: "ok",
        sampling: { callsPerSample: 3, callsPerSampleFixed: true },
      });
    });
  });

  describe("when measure rejects", () => {
    it("fails in the phase of what the case threw", async () => {
      const result = await measureShort(LIFECYCLE, "fn-throws");

      expect(result).toMatchObject({ status: "failed", error: { phase: "fn" } });
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

    it.each([
      { id: "fn-throws-string", thrown: "a value that is not an Error", message: "pear" },
      {
        id: "fn-throws-numeric-stack",
        thrown: "an Error whose stack is not a string",
        message: "plum",
      },
    ])("carries a null stack when the case throws $thrown", async ({ id, message }) => {
      const result = await runOnce(LIFECYCLE, id);

      expect(result).toStrictEqual({
        status: "failed",
        error: { phase: "fn", message, stack: null, teardownError: null },
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

/** A runtime and tsx starting, then a short measurement, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long a child may run before it is killed, so one that never exits fails instead of hanging. */
const KILL_AFTER_MS = 30_000;

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
        cases: [{ id: "orange", setupPerCall: false }],
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
        cases: [{ id: "found", setupPerCall: false }],
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
