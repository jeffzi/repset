import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ChildRequest } from "../src/child.js";
import {
  childEntryBeside,
  findRuntime,
  startChild,
  type FoundRuntime,
  type Outcome,
  type StartOptions,
} from "../src/children.js";
import { ConfigError } from "../src/options.js";
import { errorOf } from "./measure/fixtures.js";
import { requiresRealBunHere } from "./real-bun.js";

const FIXTURES = fileURLToPath(new URL("fixtures/children/", import.meta.url));

/** The absolute path of the children fixture `name`. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

/** The absolute path of the benchmark file `name` the child tests use. */
function benchFile(name: string): string {
  return fileURLToPath(new URL(`fixtures/child/${name}`, import.meta.url));
}

/** Windows has no signal a process can die on, and runs no shell script as an executable. */
const POSIX = process.platform !== "win32";

/** A runtime and tsx starting, then a short measurement, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** The `timeout` of a child that must not be killed, so one that never exits fails instead of hanging. */
const KILL_AFTER_MS = 30_000;

/** The `timeout` of a child that must be killed; the hanging fixtures end by themselves after 5 s. */
const SHORT_TIMEOUT_MS = 1000;

/** How long past its `timeout` or its stop a killed child's call may take to return. */
const RETURN_MARGIN_MS = 2000;

const NODE: FoundRuntime = {
  runtime: "node",
  executable: process.execPath,
  version: process.versions.node,
};

/** A request the fixtures ignore. */
const ONCE: ChildRequest = { mode: "once", file: FIXTURES, id: "apple" };

/** Starts the fixture `name` in place of the child entry, on Node, with no import. */
async function startFixture(
  name: string,
  request: ChildRequest = ONCE,
  options: Partial<StartOptions> = {},
): Promise<Outcome> {
  return startChild(NODE, request, {
    timeout: KILL_AFTER_MS,
    nodeImport: undefined,
    entry: fixture(name),
    ...options,
  });
}

/** Runs `start` and returns its outcome with the milliseconds it took. */
async function timed(start: () => Promise<Outcome>): Promise<[Outcome, number]> {
  const started = performance.now();
  const outcome = await start();
  return [outcome, performance.now() - started];
}

/** The failure of a child that left no usable result line. */
const NO_RESULT = { status: "failed", error: { phase: "child", stack: null } };

const LISTED_LINE = '{"status":"ok","cases":[{"id":"apple","setupPerCall":false}]}';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("childEntryBeside", () => {
  it.each([
    { module: join(FIXTURES, "dist", "children.js"), entry: join(FIXTURES, "dist", "child.js") },
    { module: join(FIXTURES, "src", "children.ts"), entry: join(FIXTURES, "src", "child.ts") },
  ])("finds $entry beside $module", ({ module, entry }) => {
    expect(childEntryBeside(module)).toBe(entry);
  });
});

describe("findRuntime", () => {
  describe("when the runtime is the one the parent runs on", () => {
    it("returns the parent's own executable and version, whatever PATH holds", async () => {
      vi.stubEnv("PATH", FIXTURES);

      const found = await findRuntime("node");

      expect(found).toStrictEqual(NODE);
    });
  });

  describe("when the runtime is the other one", () => {
    it.runIf(POSIX)(
      "returns its executable on PATH and its version without a leading v",
      async () => {
        vi.stubEnv("PATH", fixture("bin/version"));

        const found = await findRuntime("bun");

        expect(found).toStrictEqual({
          runtime: "bun",
          executable: fixture("bin/version/bun"),
          version: "9.8.7",
        });
      },
    );

    it("throws a ConfigError naming the runtime when PATH holds no executable for it", async () => {
      vi.stubEnv("PATH", FIXTURES);

      const found = findRuntime("bun");

      await expect(found).rejects.toThrow(ConfigError);
      await expect(found).rejects.toThrow(/\bbun\b/);
    });

    it.runIf(POSIX).each([
      { why: "exits non-zero", dir: "fails" },
      { why: "dies on a signal", dir: "killed" },
      { why: "prints nothing", dir: "silent" },
    ])("throws a ConfigError naming the executable when its probe $why", async ({ dir }) => {
      vi.stubEnv("PATH", fixture(`bin/${dir}`));

      const found = findRuntime("bun");

      await expect(found).rejects.toThrow(ConfigError);
      await expect(found).rejects.toThrow(fixture(`bin/${dir}/bun`));
    });

    it.runIf(POSIX).each([
      { why: "the exit status of a probe that exits non-zero", dir: "fails", ended: /\b7\b/ },
      { why: "the signal of a probe that dies on one", dir: "killed", ended: /SIGKILL/ },
    ])("names $why", async ({ dir, ended }) => {
      vi.stubEnv("PATH", fixture(`bin/${dir}`));

      const found = findRuntime("bun");

      await expect(found).rejects.toThrow(ended);
    });
  });
});

describe("startChild", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when the child wrote one line that answers its request", () => {
    it.each([
      {
        why: "a once run",
        request: { mode: "once", file: '{"status":"ok"}\n', id: "apple" },
        expected: { status: "ok", result: { status: "ok" }, output: "" },
      },
      {
        why: "a listing",
        request: { mode: "list", file: `${LISTED_LINE}\n` },
        expected: {
          status: "ok",
          result: { status: "ok", cases: [{ id: "apple", setupPerCall: false }] },
          output: "",
        },
      },
      {
        why: "the child's own failure",
        request: {
          mode: "once",
          file: '{"status":"failed","error":{"phase":"fn","message":"kiwi","stack":"at fn"}}\n',
          id: "apple",
        },
        expected: {
          status: "failed",
          error: { phase: "fn", message: "kiwi", stack: "at fn" },
          output: "",
        },
      },
      {
        why: "the child's own failure with no stack",
        request: {
          mode: "once",
          file: '{"status":"failed","error":{"phase":"load","message":"kiwi","stack":null}}\n',
          id: "apple",
        },
        expected: {
          status: "failed",
          error: { phase: "load", message: "kiwi", stack: null },
          output: "",
        },
      },
    ] as const)("returns $why", async ({ request, expected }) => {
      const outcome = await startFixture("echo.ts", request);

      expect(outcome).toStrictEqual(expected);
    });

    it("keeps the result when the child then exited non-zero", async () => {
      const outcome = await startFixture("line-then-exit.ts");

      expect(outcome).toStrictEqual({ status: "ok", result: { status: "ok" }, output: "" });
    });

    it.runIf(POSIX)("keeps the result when the child then died on a signal", async () => {
      const outcome = await startFixture("line-then-kill.ts");

      expect(outcome).toStrictEqual({ status: "ok", result: { status: "ok" }, output: "" });
    });

    it("keeps the result when the child then passed its timeout", async () => {
      const outcome = await startFixture("line-then-hang.ts", ONCE, { timeout: SHORT_TIMEOUT_MS });

      expect(outcome).toStrictEqual({ status: "ok", result: { status: "ok" }, output: "" });
    });
  });

  describe("when the child left no usable result line", () => {
    it.each([
      { why: "no line", request: { mode: "list", file: "" } },
      { why: "a line with no newline", request: { mode: "list", file: LISTED_LINE } },
      { why: "a line that is not JSON", request: { mode: "list", file: "banana\n" } },
      {
        why: "more than one line",
        request: { mode: "list", file: `${LISTED_LINE}\n${LISTED_LINE}\n` },
      },
      {
        why: "a once result for a list request",
        request: { mode: "list", file: '{"status":"ok"}\n' },
      },
      {
        why: "a listing for a measure request",
        request: {
          mode: "measure",
          file: `${LISTED_LINE}\n`,
          id: "apple",
          minTime: 5,
          minSamples: 8,
        },
      },
      {
        why: "a failure with no message",
        request: {
          mode: "once",
          file: '{"status":"failed","error":{"phase":"fn","stack":null}}\n',
          id: "apple",
        },
      },
    ] as const)("fails in phase child with a null stack for $why", async ({ request }) => {
      const outcome = await startFixture("echo.ts", request);

      expect(outcome).toMatchObject(NO_RESULT);
    });

    it("counts the lines of a child that wrote more than one", async () => {
      const request = { mode: "list", file: `${LISTED_LINE}\n${LISTED_LINE}\n` } as const;

      const outcome = await startFixture("echo.ts", request);

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringContaining(" 2 lines ") },
      });
    });

    it("carries the parse error of a line that is not JSON", async () => {
      const parseError = errorOf(() => JSON.parse("banana"));

      const outcome = await startFixture("echo.ts", { mode: "list", file: "banana\n" });

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringContaining(parseError.message) },
      });
    });

    it("quotes the first 200 characters of a line that does not answer its request", async () => {
      const line = JSON.stringify({ status: "ok", pear: "x".repeat(300) });

      const outcome = await startFixture("echo.ts", { mode: "list", file: `${line}\n` });

      expect(outcome).toMatchObject({ ...NO_RESULT });
      const { message } = outcome.status === "failed" ? outcome.error : { message: "" };
      expect(message.endsWith(`: ${line.slice(0, 200)}`)).toBe(true);
    });

    it("names the exit status of a child that exited before writing one", async () => {
      const outcome = await startFixture("exit-early.ts");

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringMatching(/\b3\b/) },
      });
    });

    it.runIf(POSIX)("names the signal of a child that died before writing one", async () => {
      const outcome = await startFixture("self-kill.ts");

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringContaining("SIGKILL") },
      });
    });

    it("names the spawn error of a child that could not be started", async () => {
      const missing: FoundRuntime = { ...NODE, executable: fixture("banana") };

      const outcome = await startChild(missing, ONCE, {
        timeout: KILL_AFTER_MS,
        nodeImport: undefined,
      });

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringContaining("ENOENT") },
      });
    });
  });

  describe("when the child runs past its timeout", () => {
    it("kills it and fails in phase child naming the timeout", async () => {
      const [outcome, elapsed] = await timed(async () =>
        startFixture("hang.ts", ONCE, { timeout: SHORT_TIMEOUT_MS }),
      );

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringMatching(/\b1000\b/) },
      });
      expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS + RETURN_MARGIN_MS);
    });

    it("returns in time when a process the child started holds its pipes open", async () => {
      const [outcome, elapsed] = await timed(async () =>
        startFixture("hold-pipes.ts", ONCE, { timeout: SHORT_TIMEOUT_MS }),
      );

      expect(outcome.output).toContain("plum\n");
      expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS + RETURN_MARGIN_MS);
    });
  });

  describe("when the caller's stop signal fires while the child runs", () => {
    it("kills the child and ends as stopped", async () => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 300);

      const [outcome, elapsed] = await timed(async () =>
        startFixture("hang.ts", ONCE, { signal: controller.signal }),
      );

      expect(outcome).toStrictEqual({ status: "stopped", output: "" });
      expect(elapsed).toBeLessThan(300 + RETURN_MARGIN_MS);
    });
  });

  describe("when the caller's stop signal fires after the child wrote its result", () => {
    it("ends as stopped", async () => {
      const dir = mkdtempSync(join(tmpdir(), "repset-children-"));
      onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      const marker = join(dir, "written");
      const controller = new AbortController();
      const abortOnceWritten = setInterval(() => {
        if (existsSync(marker)) controller.abort();
      }, 20);

      const outcome = await startFixture(
        "line-then-mark.ts",
        { mode: "once", file: marker, id: "apple" },
        { signal: controller.signal },
      );
      clearInterval(abortOnceWritten);

      expect(outcome).toStrictEqual({ status: "stopped", output: "" });
    });
  });

  describe("the output tail", () => {
    it("keeps short output of both streams whole", async () => {
      const outcome = await startFixture("print.ts");

      expect(outcome.output).toHaveLength("plum\npear\n".length);
      expect(outcome.output).toContain("plum\n");
      expect(outcome.output).toContain("pear\n");
    });

    it("keeps the last 16 KiB, cut at a character boundary", async () => {
      const outcome = await startFixture("euro.ts");

      expect(outcome.output).toBe("€".repeat(Math.floor((16 * 1024) / 3)));
    });

    it("keeps the last 16 KiB of a child that prints more", async () => {
      const outcome = await startChild(
        NODE,
        { mode: "list", file: benchFile("loud.ts") },
        { timeout: KILL_AFTER_MS, nodeImport: "tsx" },
      );

      expect(outcome).toMatchObject({ status: "ok", result: { cases: [{ id: "loud" }] } });
      expect(Buffer.byteLength(outcome.output)).toBe(16 * 1024);
    });
  });
});

describe.each([
  { runtime: "node", here: true },
  { runtime: "bun", here: requiresRealBunHere() },
] as const)(
  "startChild with the child entry on $runtime",
  { timeout: SPAWN_TIMEOUT_MS },
  ({ runtime, here }) => {
    describe.runIf(here)("when the request is valid", () => {
      it("returns the listing of a benchmark file", async () => {
        const found = await findRuntime(runtime);

        const outcome = await startChild(
          found,
          { mode: "list", file: benchFile("three-cases.ts") },
          { timeout: KILL_AFTER_MS, nodeImport: "tsx" },
        );

        expect(outcome).toStrictEqual({
          status: "ok",
          result: {
            status: "ok",
            cases: [
              { id: "alpha", setupPerCall: false },
              { id: "beta", setupPerCall: true },
              { id: "gamma", setupPerCall: false },
            ],
          },
          output: expect.any(String),
        });
      });

      it("returns the measurement of one case", async () => {
        const found = await findRuntime(runtime);

        const outcome = await startChild(
          found,
          {
            mode: "measure",
            file: benchFile("lifecycle.ts"),
            id: "steady",
            minTime: 5,
            minSamples: 8,
          },
          { timeout: KILL_AFTER_MS, nodeImport: "tsx" },
        );

        expect(outcome).toMatchObject({
          status: "ok",
          result: { status: "ok", stats: { sampleCount: expect.any(Number) } },
        });
      });
    });
  },
);

describe(
  "startChild with a nodeImport that cannot be resolved",
  { timeout: SPAWN_TIMEOUT_MS },
  () => {
    const LIST = { mode: "list", file: benchFile("three-cases.ts") } as const;

    it("fails a Node child in phase child", async () => {
      const request = { mode: "once", file: '{"status":"ok"}\n', id: "apple" } as const;

      const outcome = await startFixture("echo.ts", request, { nodeImport: "banana" });

      expect(outcome).toMatchObject(NO_RESULT);
    });

    it.runIf(requiresRealBunHere())("runs a Bun child as it does without one", async () => {
      const bun = await findRuntime("bun");

      const outcome = await startChild(bun, LIST, { timeout: KILL_AFTER_MS, nodeImport: "banana" });

      expect(outcome).toMatchObject({
        status: "ok",
        result: { cases: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
      });
    });
  },
);
