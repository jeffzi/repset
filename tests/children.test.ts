import { copyFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startChild as startBuiltChild } from "../dist/children.js";
import type { ChildRequest } from "../src/child.js";
import {
  findRuntime,
  startChild,
  type FoundRuntime,
  type Outcome,
  type StartOptions,
} from "../src/children.js";
import { expectConfigError } from "./config-error.js";
import { errorOf } from "./error-of.js";
import { MELON } from "./fake-children.js";
import { requiresRealBunHere, runtimesHere } from "./real-bun.js";
import { suiteTemporaryDir, temporaryDir } from "./temporary-dir.js";

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

/** How a runtime lookup is bounded when its probe must not be killed. */
const LOOKUP = { timeout: KILL_AFTER_MS } as const;

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

/** A once request whose `file` is the text the `echo.ts` fixture writes back as the child's result. */
function echoing(written: string): ChildRequest {
  return { mode: "once", file: written, id: "apple" };
}

/** The result line of a child whose own failure is `error`. */
function failureLine(error: object): string {
  return `${JSON.stringify({ status: "failed", error })}\n`;
}

/** Runs `start` and returns what it resolved to with the milliseconds it took. */
async function timed<T>(start: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const outcome = await start();
  return [outcome, performance.now() - started];
}

/** The fields of a child's own failure in phase fn, before its `teardownError`. */
const FN_KIWI = { phase: "fn", message: "kiwi", stack: "at fn" } as const;

/** The failure of a child that left no usable result line. */
const NO_RESULT = { status: "failed", error: { phase: "child", stack: null } };

const LISTED_LINE = '{"status":"ok","cases":[{"id":"apple","setupPerCall":false}]}';

/** A measurement complete in every field, whose `status` alone does not answer a measure request. */
const MEASURED_PEAR_LINE = JSON.stringify({
  status: "pear",
  stats: { min: 1, p25: 1, median: 1, p75: 1, p99: 1, max: 1, mean: 1, sampleCount: 8 },
  sampling: {
    timerResolutionNs: 1,
    callsPerSample: 1,
    warmupSamples: 1,
    timingAttempts: 1,
    timingMs: 5,
    callsPerSampleFixed: false,
  },
  checks: { ratioToEmptyBody: 1 },
  gc: null,
});

describe("findRuntime", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when the runtime is the one the parent runs on", () => {
    it("returns the parent's own executable and version, whatever PATH holds", async () => {
      vi.stubEnv("PATH", FIXTURES);

      const found = await findRuntime("node", LOOKUP);

      expect(found).toStrictEqual(NODE);
    });
  });

  describe("when the runtime is the other one", () => {
    describe("when PATH holds an executable for it", () => {
      /** A directory holding a copy of this Node executable named `bun`, which Windows can run. */
      const dir = suiteTemporaryDir("repset-bun-");
      let bun: string;

      beforeAll(() => {
        bun = join(dir.path, `bun${extname(process.execPath)}`);
        copyFileSync(process.execPath, bun);
      });

      it("returns that executable and its version without a leading v", async () => {
        vi.stubEnv("PATH", dir.path);

        const found = await findRuntime("bun", LOOKUP);

        expect(found).toStrictEqual({
          runtime: "bun",
          executable: bun,
          version: process.versions.node,
        });
      });

      describe("when its probe fails", () => {
        it("throws a ConfigError naming the executable's exit status when its probe exits non-zero", async () => {
          vi.stubEnv("PATH", dir.path);
          // Node refuses an unknown option in NODE_OPTIONS with exit status 9, before `--version`.
          vi.stubEnv("NODE_OPTIONS", "--banana");

          const found = findRuntime("bun", LOOKUP);

          await expectConfigError(found, [bun, /\b9\b/]);
        });

        it.runIf(POSIX)(
          "throws a ConfigError naming the executable's signal when its probe dies on one",
          async () => {
            vi.stubEnv("PATH", fixture("bin/killed"));

            const found = findRuntime("bun", LOOKUP);

            await expectConfigError(found, [fixture("bin/killed/bun"), /SIGKILL/]);
          },
        );

        it.runIf(POSIX)(
          "throws a ConfigError naming the executable when its probe prints nothing",
          async () => {
            vi.stubEnv("PATH", fixture("bin/silent"));

            const found = findRuntime("bun", LOOKUP);

            await expectConfigError(found, [fixture("bin/silent/bun")]);
          },
        );

        it.runIf(POSIX)(
          "throws a ConfigError naming the executable and the timeout when its probe runs past it",
          async () => {
            vi.stubEnv("PATH", fixture("bin/hang"));

            const found = findRuntime("bun", { timeout: SHORT_TIMEOUT_MS });

            await expectConfigError(found, [
              fixture("bin/hang/bun"),
              new RegExp(`\\b${String(SHORT_TIMEOUT_MS)}\\b`, "u"),
            ]);
          },
        );

        it.runIf(POSIX)(
          "throws a ConfigError naming the executable when its probe cannot be started",
          async () => {
            vi.stubEnv("PATH", fixture("bin/no-interpreter"));

            const found = findRuntime("bun", LOOKUP);

            await expectConfigError(found, [fixture("bin/no-interpreter/bun")]);
          },
        );
      });
    });

    describe("when its probe exits while a process it started holds its stdout", () => {
      it.runIf(POSIX)("returns the printed version in time", async () => {
        vi.stubEnv("PATH", fixture("bin/linger"));

        const [found, elapsed] = await timed(async () => findRuntime("bun", LOOKUP));

        expect(found.version).toBe("1.3.2");
        expect(elapsed).toBeLessThan(RETURN_MARGIN_MS);
      });
    });

    it("throws a ConfigError naming the runtime when PATH holds no executable for it", async () => {
      vi.stubEnv("PATH", FIXTURES);

      const found = findRuntime("bun", LOOKUP);

      await expectConfigError(found, [/\bbun\b/]);
    });

    it("throws a ConfigError naming the runtime when PATH is unset", async () => {
      vi.stubEnv("PATH", undefined);

      const found = findRuntime("bun", LOOKUP);

      await expectConfigError(found, [/\bbun\b/]);
    });

    describe("when PATH holds only an empty entry", () => {
      const startDir = process.cwd();

      afterEach(() => {
        process.chdir(startDir);
      });

      it("throws a ConfigError naming the runtime instead of searching the working directory", async () => {
        const dir = temporaryDir("repset-cwd-");
        copyFileSync(process.execPath, join(dir, `bun${extname(process.execPath)}`));
        process.chdir(dir);
        vi.stubEnv("PATH", "");
        // A copy found in the working directory would then fail its probe instead of resolving.
        vi.stubEnv("NODE_OPTIONS", "--banana");

        const found = findRuntime("bun", LOOKUP);

        await expectConfigError(found, [/\bbun\b/]);
        // Every error of a probe that ran names its `--version`; one found on no PATH entry does not.
        await expect(found).rejects.not.toThrow(/--version/);
      });
    });
  });
});

describe("startChild", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when the child wrote one line that answers its request", () => {
    it.each([
      {
        why: "a once run",
        request: echoing('{"status":"ok"}\n'),
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
        request: echoing(
          '{"status":"failed","error":{"phase":"fn","message":"kiwi","stack":"at fn","teardownError":null}}\n',
        ),
        expected: {
          status: "failed",
          error: { phase: "fn", message: "kiwi", stack: "at fn", teardownError: null },
          output: "",
        },
      },
      {
        why: "the child's own failure whose cleanup teardown failed too",
        request: echoing(failureLine({ ...FN_KIWI, teardownError: MELON })),
        expected: {
          status: "failed",
          error: { ...FN_KIWI, teardownError: MELON },
          output: "",
        },
      },
      {
        why: "the child's own failure with no stack",
        request: echoing(
          '{"status":"failed","error":{"phase":"load","message":"kiwi","stack":null,"teardownError":null}}\n',
        ),
        expected: {
          status: "failed",
          error: { phase: "load", message: "kiwi", stack: null, teardownError: null },
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

    it("keeps the result when the child then passed its timeout", async () => {
      const outcome = await startFixture("line-then-hang.ts", ONCE, { timeout: SHORT_TIMEOUT_MS });

      expect(outcome).toStrictEqual({ status: "ok", result: { status: "ok" }, output: "" });
    });
  });

  describe("when the child left no usable result line", () => {
    it.each([
      { why: "no line", request: { mode: "list", file: "" } },
      { why: "a line with no newline", request: { mode: "list", file: LISTED_LINE } },
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
      { why: "a listing for a once request", request: echoing(`${LISTED_LINE}\n`) },
      {
        why: "a failure with no message",
        request: echoing(
          '{"status":"failed","error":{"phase":"fn","stack":null,"teardownError":null}}\n',
        ),
      },
      { why: "a failure with no teardownError", request: echoing(failureLine(FN_KIWI)) },
      {
        why: "a failure whose teardownError has no stack",
        request: echoing(failureLine({ ...FN_KIWI, teardownError: { message: "melon" } })),
      },
    ] as const)("fails in phase child with a null stack for $why", async ({ request }) => {
      const outcome = await startFixture("echo.ts", request);

      expect(outcome).toMatchObject(NO_RESULT);
    });

    it("names the measure request in the failure when the measurement's status is neither ok nor failed", async () => {
      const request = {
        mode: "measure",
        file: `${MEASURED_PEAR_LINE}\n`,
        id: "apple",
        minTime: 5,
        minSamples: 8,
      } as const;

      const outcome = await startFixture("echo.ts", request);

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringMatching(/\bmeasure\b/) },
      });
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

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: {
          ...NO_RESULT.error,
          message: expect.stringMatching(/: \{"status":"ok","pear":"x{177}$/u),
        },
      });
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
    it("fails in phase child naming the timeout", async () => {
      const outcome = await startFixture("hang.ts", ONCE, { timeout: SHORT_TIMEOUT_MS });

      expect(outcome).toMatchObject({
        ...NO_RESULT,
        error: { ...NO_RESULT.error, message: expect.stringMatching(/\b1000\b/) },
      });
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
    it("ends as stopped, killing the child within the return margin", async () => {
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

    it("ends as stopped before its timeout when the signal fired before the start", async () => {
      const controller = new AbortController();
      controller.abort();

      const outcome = await startFixture("hang.ts", ONCE, {
        signal: controller.signal,
        timeout: SHORT_TIMEOUT_MS,
      });

      expect(outcome).toStrictEqual({ status: "stopped", output: "" });
    });
  });

  describe("when the caller's stop signal fires after the child wrote its result", () => {
    it("ends as stopped", async () => {
      const dir = temporaryDir("repset-children-");
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

  describe("when the child prints", () => {
    it("keeps short output of both streams whole", async () => {
      const outcome = await startFixture("print.ts");

      expect(outcome.output).toHaveLength("plum\npear\n".length);
      expect(outcome.output).toContain("plum\n");
      expect(outcome.output).toContain("pear\n");
    });

    it("keeps the last 16 KiB of output longer than one read", async () => {
      const outcome = await startFixture("megabyte.ts");

      expect(outcome.output).toBe("z".repeat(16 * 1024));
    });

    it("keeps the last 16 KiB, cut at a character boundary", async () => {
      const outcome = await startFixture("euro.ts");

      expect(outcome.output).toBe("€".repeat(Math.floor((16 * 1024) / 3)));
    });

    it("returns the result of a child entry that prints a megabyte to each stream", async () => {
      const outcome = await startChild(
        NODE,
        { mode: "list", file: benchFile("loud.ts") },
        { timeout: KILL_AFTER_MS, nodeImport: "tsx" },
      );

      expect(outcome).toMatchObject({ status: "ok", result: { cases: [{ id: "loud" }] } });
    });
  });

  describe.each(runtimesHere())("with the child entry on $runtime", ({ runtime, here }) => {
    describe.runIf(here)("when the request is valid", () => {
      it("returns the measurement of one case", async () => {
        const found = await findRuntime(runtime, LOOKUP);

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
  });

  describe("from the built dist/children.js", () => {
    it("starts the built child entry beside it", async () => {
      const outcome = await startBuiltChild(
        NODE,
        { mode: "list", file: benchFile("three-cases.ts") },
        { timeout: KILL_AFTER_MS, nodeImport: "tsx" },
      );

      expect(outcome).toMatchObject({
        status: "ok",
        result: { cases: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
      });
    });
  });

  describe("with a nodeImport that cannot be resolved", () => {
    const LIST = { mode: "list", file: benchFile("three-cases.ts") } as const;

    it.runIf(requiresRealBunHere())("runs a Bun child as it does without one", async () => {
      const bun = await findRuntime("bun", LOOKUP);

      const outcome = await startChild(bun, LIST, { timeout: KILL_AFTER_MS, nodeImport: "banana" });

      expect(outcome).toMatchObject({
        status: "ok",
        result: { cases: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
      });
    });
  });
});
