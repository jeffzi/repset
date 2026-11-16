import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Outcome } from "../src/children.js";
import { ConfigError } from "../src/options.js";
import type { Report, Result } from "../src/report.js";
import { run, runOnce } from "../src/run.js";
import {
  failedOutcome,
  findAny,
  MELON,
  measured,
  starter as fakeStarter,
  type StartChild,
  stopped,
} from "./fake-children.js";

const DISCOVERY = fileURLToPath(new URL("fixtures/discovery", import.meta.url));

const RUN_FIXTURES = fileURLToPath(new URL("fixtures/run", import.meta.url));

/** A stand-in for the package's `package.json` whose version is `1.2.3`. */
const VERSIONED = join(RUN_FIXTURES, "version.json");

/** A config file that sets `nodeImport` to `./loader.mjs`, beside which `loader.mjs` resolves. */
const DOT_IMPORT_CONFIG = fileURLToPath(
  new URL("fixtures/config/nested/dot-import.ts", import.meta.url),
);

const STARTED_AT = new Date("2026-11-01T12:00:00.000Z");

/** The one case the fake listing child finds in `file`: named for the file, per-call only in `a.bench.ts`. */
function caseOf(file: string): { id: string; setupPerCall: boolean } {
  const id = basename(file);
  return { id, setupPerCall: id === "a.bench.ts" };
}

/** An outcome in which the child measured its case with the median `median`. */
function measuredOutcome(median: number): Outcome {
  return { status: "ok", result: measured(median), output: "" };
}

/** An outcome in which the child ran its case once. */
const ranOnce: Outcome = { status: "ok", result: { status: "ok" }, output: "" };

/** A child starter that lists one case per file and answers the rest with `answer`. */
function starter(answer: Parameters<typeof fakeStarter>[1]): StartChild {
  return fakeStarter(caseOf, answer);
}

/** A child starter that measures every case with the median 4656. */
const measuresAll = starter(() => measuredOutcome(4656));

/** A child starter that fails the run with a plain error if it starts a measuring or once child. */
const startsNoChild = starter(() => {
  throw new Error("a child started");
});

/** One CPU of the fake host, as `os.cpus()` lists it. */
function cpu(model: string): { model: string } {
  return { model };
}

type RunInput = Parameters<typeof run>[0];

/** Runs from the discovery fixtures with no config file, the fake lookup and the 1.2.3 version. */
async function runHere(input: Partial<RunInput> = {}): ReturnType<typeof run> {
  return run({
    cwd: DISCOVERY,
    config: false,
    files: ["zeta.bench.ts"],
    findRuntime: findAny,
    startChild: measuresAll,
    packageJson: VERSIONED,
    cpus: () => [cpu("Apple M2 Max")],
    ...input,
  });
}

type OnceInput = Parameters<typeof runOnce>[0];

/** Runs every case once from the discovery fixtures with no config file and the fake lookup. */
async function runOnceHere(input: Partial<OnceInput> = {}): ReturnType<typeof runOnce> {
  return runOnce({
    cwd: DISCOVERY,
    config: false,
    files: ["zeta.bench.ts"],
    findRuntime: findAny,
    startChild: starter(() => ranOnce),
    ...input,
  });
}

/** Freezes `Date` at `STARTED_AT`, leaving every timer real. */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(STARTED_AT);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("run", () => {
  describe("the report", () => {
    it("holds the inputs, the host and each measured case's result", async () => {
      freezeClock();

      const report = await runHere({
        cwd: join(DISCOVERY, "nested"),
        files: ["../a.bench.ts"],
        filter: "bench",
        runtimes: ["node"],
        minTime: 5,
        minSamples: 8,
        timeout: 1234,
        nodeImport: "tsx",
        cpus: () => [cpu("Apple M2 Max"), cpu("Apple M2 Max"), cpu("Apple M2 Max")],
      });

      expect(report).toStrictEqual({
        schema: 1,
        repset: "1.2.3",
        startedAt: "2026-11-01T12:00:00.000Z",
        interrupted: false,
        options: {
          runtimes: ["node"],
          files: ["../a.bench.ts"],
          filter: "bench",
          minTime: 5,
          minSamples: 8,
          rounds: null,
          seed: null,
          timeout: 1234,
          nodeImport: "tsx",
          rawSamples: false,
        },
        machine: { os: process.platform, arch: process.arch, cpu: "Apple M2 Max", cores: 3 },
        results: [
          {
            id: "a.bench.ts",
            name: "a.bench.ts",
            contender: null,
            params: {},
            file: "../a.bench.ts",
            runtime: { name: "node", version: "24.1.0" },
            setupPerCall: true,
            status: "ok",
            error: null,
            median: 4656,
            processes: [
              {
                round: 1,
                orderInRound: 1,
                stats: measured(4656).stats,
                sampling: measured(4656).sampling,
                checks: measured(4656).checks,
                gc: measured(4656).gc,
                rawSamples: null,
              },
            ],
          },
        ],
        contests: [],
      });
    });

    it("records files, filter and nodeImport as null when none was given", async () => {
      const report = await runHere({ files: undefined, include: ["zeta.bench.ts"] });

      const { files, filter, nodeImport } = report.options;
      expect({ files, filter, nodeImport }).toStrictEqual({
        files: null,
        filter: null,
        nodeImport: null,
      });
    });

    it("records a relative nodeImport from the config file as written", async () => {
      const report = await runHere({ config: DOT_IMPORT_CONFIG });

      expect(report.options.nodeImport).toBe("./loader.mjs");
    });

    it("records a null cpu and cores when the OS lists no CPU", async () => {
      const report = await runHere({ cpus: () => [] });

      expect(report.machine).toStrictEqual({
        os: process.platform,
        arch: process.arch,
        cpu: null,
        cores: null,
      });
    });

    it("records the time run was called as startedAt, not a later one", async () => {
      freezeClock();
      const later = starter(() => {
        vi.setSystemTime(new Date("2026-11-01T13:00:00.000Z"));
        return measuredOutcome(4656);
      });

      const report = await runHere({ startChild: later });

      expect(report.startedAt).toBe("2026-11-01T12:00:00.000Z");
    });
  });

  describe("the measuring children", () => {
    it("starts one per case per runtime, runtime by runtime, with the merged minTime and minSamples", async () => {
      const echo = starter((request, runtime) => {
        const asked = [runtime.runtime, basename(request.file), request.id];
        if (request.mode === "measure")
          asked.push(String(request.minTime), String(request.minSamples));
        return failedOutcome("fn", asked.join(" "));
      });

      const report = await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        runtimes: ["bun", "node"],
        minTime: 7,
        minSamples: 9,
        startChild: echo,
      });

      expect(
        report.results.map((result) => [result.runtime.name, result.id, result.error?.message]),
      ).toStrictEqual([
        ["bun", "zeta.bench.ts", "bun zeta.bench.ts zeta.bench.ts 7 9"],
        ["bun", "a.bench.ts", "bun a.bench.ts a.bench.ts 7 9"],
        ["node", "zeta.bench.ts", "node zeta.bench.ts zeta.bench.ts 7 9"],
        ["node", "a.bench.ts", "node a.bench.ts a.bench.ts 7 9"],
      ]);
    });

    it.each([
      { why: "the count it is given", callsPerSample: 5, asked: ["5", "5"] },
      { why: "no count when it is given none", callsPerSample: undefined, asked: ["none", "none"] },
    ])("asks each one for $why", async ({ callsPerSample, asked }) => {
      const echoCount = starter((request) =>
        failedOutcome(
          "fn",
          request.mode === "measure" && "callsPerSample" in request
            ? String(request.callsPerSample)
            : "none",
        ),
      );

      const report = await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        startChild: echoCount,
        ...(callsPerSample === undefined ? {} : { callsPerSample }),
      });

      expect(report.results.map((result) => result.error?.message)).toStrictEqual(asked);
    });
  });

  describe("when a case fails", () => {
    it.each([
      {
        why: "answers with a failure whose cleanup teardown failed too",
        outcome: {
          status: "failed",
          error: { phase: "fn", message: "kiwi", stack: "at fn", teardownError: MELON },
          output: "plum\n",
        },
        error: {
          phase: "fn",
          message: "kiwi",
          stack: "at fn",
          teardownError: MELON,
          output: "plum\n",
        },
      },
      {
        why: "answers with no measurement",
        outcome: { status: "ok", result: { status: "ok" }, output: "plum\n" },
        error: {
          phase: "child",
          message: expect.any(String),
          stack: null,
          teardownError: null,
          output: "plum\n",
        },
      },
    ] as const)("gives a failed result when its child $why", async ({ outcome, error }) => {
      const report = await runHere({ startChild: starter(() => outcome) });

      expect(report.results).toStrictEqual([
        {
          id: "zeta.bench.ts",
          name: "zeta.bench.ts",
          contender: null,
          params: {},
          file: "zeta.bench.ts",
          runtime: { name: "node", version: "24.1.0" },
          setupPerCall: false,
          status: "failed",
          error,
          median: null,
          processes: [
            {
              round: 1,
              orderInRound: 1,
              stats: null,
              sampling: null,
              checks: null,
              gc: null,
              rawSamples: null,
            },
          ],
        },
      ]);
    });
  });

  describe("onResult", () => {
    it("receives each result in run order before the next child starts", async () => {
      const received: Result[] = [];
      const countsReceived = starter(() => measuredOutcome(received.length));

      const report = await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        runtimes: ["node", "bun"],
        startChild: countsReceived,
        onResult: (result) => {
          received.push(result);
        },
      });

      expect(report.results.map((result) => result.median)).toStrictEqual([0, 1, 2, 3]);
      expect(received).toStrictEqual(report.results);
    });
  });

  describe("onSelected", () => {
    it("receives the report with no result once listing passed, before the first measuring child", async () => {
      let selected: Report | undefined;
      const seesSelected = starter(() => measuredOutcome(selected === undefined ? 0 : 1));

      const report = await runHere({
        startChild: seesSelected,
        onSelected: (head) => {
          selected = head;
        },
      });

      expect(report.results.map((result) => result.median)).toStrictEqual([1]);
      expect(selected).toStrictEqual({ ...report, results: [] });
    });

    it("is not called when the stop signal fires during listing", async () => {
      const controller = new AbortController();
      const stopping: StartChild = async () => {
        controller.abort();
        return stopped;
      };

      const report = await runHere({
        signal: controller.signal,
        startChild: stopping,
        onSelected: () => {
          throw new Error("pear");
        },
      });

      expect(report.interrupted).toBe(true);
    });
  });

  describe("the package's version", () => {
    it("throws the read error as it is, before any child starts, when package.json cannot be read", async () => {
      const result = runHere({
        packageJson: join(RUN_FIXTURES, "banana.json"),
        startChild: startsNoChild,
      });

      await expect(result).rejects.toMatchObject({ code: "ENOENT" });
      await expect(result).rejects.not.toBeInstanceOf(ConfigError);
    });

    it("throws a plain error naming the file, before any child starts, when it holds no version", async () => {
      const packageJson = join(RUN_FIXTURES, "no-version.json");

      const result = runHere({ packageJson, startChild: startsNoChild });

      await expect(result).rejects.toThrow(packageJson);
      await expect(result).rejects.not.toBeInstanceOf(ConfigError);
    });
  });

  describe("when the stop signal fires while a case is measured", () => {
    it("returns the finished results as interrupted, starting no further child", async () => {
      const controller = new AbortController();
      const stopAtA = starter((request) => {
        if (request.mode === "measure" && request.id === "a.bench.ts") {
          controller.abort();
          return stopped;
        }
        return measuredOutcome(4656);
      });

      const report = await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        runtimes: ["node", "bun"],
        signal: controller.signal,
        startChild: stopAtA,
      });

      expect({
        interrupted: report.interrupted,
        ran: report.results.map((result) => [result.runtime.name, result.id]),
      }).toStrictEqual({ interrupted: true, ran: [["node", "zeta.bench.ts"]] });
    });
  });
});

describe("runOnce", () => {
  it("runs each case once per runtime, runtime by runtime, giving that it ran or how it failed", async () => {
    const failZeta = starter((request, runtime) =>
      request.id === "zeta.bench.ts"
        ? failedOutcome(
            "fn",
            `${runtime.runtime} ${basename(request.file)} ${request.mode}`,
            runtime.runtime === "bun" ? MELON : null,
          )
        : ranOnce,
    );

    const outcome = await runOnceHere({
      files: ["zeta.bench.ts", "a.bench.ts"],
      runtimes: ["bun", "node"],
      startChild: failZeta,
    });

    expect(outcome).toStrictEqual({
      interrupted: false,
      results: [
        {
          id: "zeta.bench.ts",
          runtime: "bun",
          status: "failed",
          error: { phase: "fn", message: "bun zeta.bench.ts once", teardownError: MELON },
        },
        { id: "a.bench.ts", runtime: "bun", status: "ok" },
        {
          id: "zeta.bench.ts",
          runtime: "node",
          status: "failed",
          error: { phase: "fn", message: "node zeta.bench.ts once", teardownError: null },
        },
        { id: "a.bench.ts", runtime: "node", status: "ok" },
      ],
    });
  });
});

describe("run with a relative nodeImport from the config file", () => {
  it("starts every child under timeout with the nodeImport resolved against the config's directory", async () => {
    const resolved = fileURLToPath(new URL("fixtures/config/nested/loader.mjs", import.meta.url));
    const echoOptions: StartChild = async (_runtime, request, options) => {
      const asked = `${request.mode} ${String(options.nodeImport)} ${String(options.timeout)}`;
      if (request.mode === "list") {
        return {
          status: "ok",
          result: { status: "ok", cases: [{ id: asked, setupPerCall: false }] },
          output: "",
        };
      }
      return failedOutcome("fn", asked);
    };

    const report = await runHere({
      config: DOT_IMPORT_CONFIG,
      timeout: 1234,
      startChild: echoOptions,
    });

    expect(report.results.map((result) => [result.id, result.error?.message])).toStrictEqual([
      [`list ${resolved} 1234`, `measure ${resolved} 1234`],
    ]);
  });
});
