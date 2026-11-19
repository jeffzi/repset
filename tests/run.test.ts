import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../src/options.js";
import type { Report, Result } from "../src/report.js";
import { run, runOnce } from "../src/run.js";
import {
  failedOutcome,
  findAny,
  found,
  listed,
  MELON,
  measured,
  measuredOutcome,
  ranOnce,
  starter as fakeStarter,
  type StartChild,
  startsNoChild,
  stopped,
} from "./fake-children.js";
import { fixturePath } from "./fixture-path.js";

const DISCOVERY = fixturePath("discovery");

const RUN_FIXTURES = fixturePath("run");

/** A stand-in for the package's `package.json` whose version is `1.2.3`. */
const VERSIONED = join(RUN_FIXTURES, "version.json");

/** The config fixtures that import a module beside them. */
const NESTED_CONFIGS = fixturePath("config", "nested");

/** A config file that sets `nodeImport` to `./loader.mjs`, beside which `loader.mjs` resolves. */
const DOT_IMPORT_CONFIG = join(NESTED_CONFIGS, "dot-import.ts");

const STARTED_AT = new Date("2026-11-01T12:00:00.000Z");

/** The one case the fake listing child finds in `file`: named for the file, per-call only in `a.bench.ts`. */
function caseOf(file: string): { id: string; setupPerCall: boolean } {
  const id = basename(file);
  return { id, setupPerCall: id === "a.bench.ts" };
}

/** A child starter that lists one case per file and answers the rest with `answer`. */
function starter(answer: Parameters<typeof fakeStarter>[1]): StartChild {
  return fakeStarter(caseOf, answer);
}

/** A child starter that measures every case with the median 4656. */
const measuresAll = starter(() => measuredOutcome(4656));

/** One CPU of the fake host, as `os.cpus()` lists it. */
function cpu(model: string): { model: string } {
  return { model };
}

type RunInput = Parameters<typeof run>[0];

/** Runs from the discovery fixtures with no config file, the fake lookup and the 1.2.3 version. */
async function runHere(input: Partial<RunInput> = {}): ReturnType<typeof run> {
  return run({
    cwd: DISCOVERY,
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
    files: ["zeta.bench.ts"],
    findRuntime: findAny,
    startChild: starter(() => ranOnce),
    ...input,
  });
}

/** Wraps `start` to log each non-listing child's mode in `events` as it starts. */
function logsStarts(events: string[], start: StartChild): StartChild {
  return async (runtime, request, options) => {
    if (request.mode !== "list") events.push(request.mode);
    return start(runtime, request, options);
  };
}

/** A plan callback that logs each non-listing phase and its child count in `events` as `planned <phase> <n>`. */
function logsPlans(events: string[]): NonNullable<OnceInput["onPlanned"]> {
  return (phase, total) => {
    if (phase !== "list") events.push(`planned ${phase} ${String(total)}`);
  };
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

      expect(report).toMatchObject({
        repset: "1.2.3",
        startedAt: "2026-11-01T12:00:00.000Z",
        interrupted: false,
        options: {
          runtimes: ["node"],
          files: ["../a.bench.ts"],
          filter: "bench",
          minTime: 5,
          minSamples: 8,
          timeout: 1234,
          nodeImport: "tsx",
        },
        machine: { os: process.platform, arch: process.arch, cpu: "Apple M2 Max", cores: 3 },
        results: [
          {
            id: "a.bench.ts",
            name: "a.bench.ts",
            file: "../a.bench.ts",
            runtime: { name: "node", version: found("node").version },
            setupPerCall: true,
            status: "ok",
            error: null,
            median: 4656,
            processes: [
              {
                stats: measured(4656).stats,
                sampling: measured(4656).sampling,
                checks: measured(4656).checks,
                gc: measured(4656).gc,
              },
            ],
          },
        ],
      });
    });

    describe("when no files, filter or nodeImport was given", () => {
      it("records each as null", async () => {
        const report = await runHere({ files: undefined, include: ["zeta.bench.ts"] });

        const { files, filter, nodeImport } = report.options;
        expect({ files, filter, nodeImport }).toStrictEqual({
          files: null,
          filter: null,
          nodeImport: null,
        });
      });
    });

    it("records a relative nodeImport from the config file as written", async () => {
      const report = await runHere({ config: DOT_IMPORT_CONFIG });

      expect(report.options.nodeImport).toBe("./loader.mjs");
    });

    describe("when the OS lists no CPU", () => {
      it("records a null cpu and cores", async () => {
        const report = await runHere({ cpus: () => [] });

        expect(report.machine).toStrictEqual({
          os: process.platform,
          arch: process.arch,
          cpu: null,
          cores: null,
        });
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

      expect(report.results).toMatchObject([
        {
          id: "zeta.bench.ts",
          name: "zeta.bench.ts",
          file: "zeta.bench.ts",
          runtime: { name: "node", version: found("node").version },
          setupPerCall: false,
          status: "failed",
          error,
          median: null,
          processes: [{ stats: null }],
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

    describe("when the stop signal fires during listing", () => {
      it("is not called", async () => {
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
  });

  describe("onPlanned", () => {
    it("receives the measuring child count before the first measuring child starts", async () => {
      const events: string[] = [];

      await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        runtimes: ["node", "bun"],
        startChild: logsStarts(events, measuresAll),
        onPlanned: logsPlans(events),
      });

      expect(events).toStrictEqual([
        "planned measure 4",
        "measure",
        "measure",
        "measure",
        "measure",
      ]);
    });
  });

  describe("the package's version", () => {
    describe("when it holds no version", () => {
      it("throws a plain error naming the file, before any child starts", async () => {
        const packageJson = join(RUN_FIXTURES, "no-version.json");

        const result = runHere({ packageJson, startChild: startsNoChild });

        await expect(result).rejects.toThrow(packageJson);
        await expect(result).rejects.not.toBeInstanceOf(ConfigError);
      });
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

  describe("when the config file sets a relative nodeImport", () => {
    it("starts every child under timeout with the nodeImport as the file URL beside the config", async () => {
      const resolved = pathToFileURL(join(NESTED_CONFIGS, "loader.mjs")).href;
      const echoOptions: StartChild = async (_runtime, request, options) => {
        const asked = `${request.mode} ${String(options.nodeImport)} ${String(options.timeout)}`;
        return request.mode === "list"
          ? listed([{ id: asked, setupPerCall: false }])
          : failedOutcome("fn", asked);
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

  describe("onPlanned", () => {
    it("receives the once child count before the first once child starts", async () => {
      const events: string[] = [];

      await runOnceHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        runtimes: ["node", "bun"],
        startChild: logsStarts(
          events,
          starter(() => ranOnce),
        ),
        onPlanned: logsPlans(events),
      });

      expect(events).toStrictEqual(["planned once 4", "once", "once", "once", "once"]);
    });
  });
});
