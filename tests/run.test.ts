import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../src/options.js";
import type { Report, Result } from "../src/report.js";
import { runOnce } from "../src/run.js";
import { expectConfigError } from "./config-error.js";
import {
  answered,
  APPLE,
  BANANA,
  contender,
  failedOutcome,
  findAny,
  found,
  listed,
  listingStarter,
  MELON,
  measured,
  measuredOutcome,
  memoryOf,
  ranOnce,
  type StartChild,
  startsNoChild,
  stopped,
} from "./fake-children.js";
import { fixturePath } from "./fixture-path.js";
import { cpu, DISCOVERY, measuresAll, type RunInput, runHere, starter } from "./run-here.js";

/** The config fixtures that import a module beside them. */
const NESTED_CONFIGS = fixturePath("config", "nested");

/** A config file that sets `nodeImport` to `./loader.mjs`, beside which `loader.mjs` resolves. */
const DOT_IMPORT_CONFIG = join(NESTED_CONFIGS, "dot-import.ts");

/** A child starter that measures every case as each request asks, reading 4656 ns and 40 B per call. */
const answersAsked = starter((request) => answered(request));

/** A child starter that lists, then fails the run with a plain error if a measuring child starts. */
const startsNoMeasuringChild = starter(() => {
  throw new Error("a measuring child started");
});

/** The time `Date` is frozen at while a run starts. */
const STARTED_AT = new Date("2026-11-01T12:00:00.000Z");

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

/** A plan callback that logs each phase's child count in `events` as `planned <n>`. */
function logsPlans(events: string[]): NonNullable<OnceInput["onPlanned"]> {
  return (total) => {
    events.push(`planned ${String(total)}`);
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
  describe("when the run completes", () => {
    it("returns a report holding the inputs, the host and each measured case's result", async () => {
      const report = await runHere({
        cwd: join(DISCOVERY, "nested"),
        files: ["../a.bench.ts"],
        filter: "bench",
        runtimes: ["node"],
        minTime: 5,
        minSampleCount: 8,
        debug: true,
        timeout: 1234,
        nodeImport: "tsx",
        cpus: () => [cpu("Apple M2 Max"), cpu("Apple M2 Max"), cpu("Apple M2 Max")],
      });
      const { time } = measured(4656);

      expect(report).toMatchObject({
        repset: "1.2.3",
        interrupted: false,
        options: {
          runtimes: ["node"],
          files: ["../a.bench.ts"],
          filter: "bench",
          minTime: 5,
          minSampleCount: 8,
          debug: true,
          timeout: 1234,
          nodeImport: "tsx",
        },
        host: { os: process.platform, arch: process.arch, cpu: "Apple M2 Max", coreCount: 3 },
        results: [
          {
            id: "a.bench.ts",
            name: "a.bench.ts",
            file: "../a.bench.ts",
            runtime: { name: "node", version: found("node").version },
            setupPerCall: true,
            status: "ok",
            error: null,
            time: { unit: "ns/call", median: 4656 },
            measurements: [{ repetition: null, orderInRepetition: null, time }],
          },
        ],
      });
    });

    it("writes every measurement's gc as null when debug is off", async () => {
      const report = await runHere({
        debug: false,
        startChild: listingStarter([APPLE, contender("join"), contender("loop")], () =>
          measuredOutcome(4656),
        ),
      });

      const gcs = report.results.flatMap((result) =>
        result.measurements.map((measurement) => measurement.time?.gc),
      );
      expect({ measured: gcs.length > 1, gcs: new Set(gcs) }).toStrictEqual({
        measured: true,
        gcs: new Set([null]),
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

    it.each([
      { contestRepetitionCount: 5, recorded: 5 },
      { contestRepetitionCount: undefined, recorded: null },
    ])(
      "records the contestRepetitionCount option $contestRepetitionCount as $recorded",
      async ({ contestRepetitionCount, recorded }) => {
        const report = await runHere(
          contestRepetitionCount === undefined ? {} : { contestRepetitionCount },
        );

        expect(report.options.contestRepetitionCount).toBe(recorded);
      },
    );

    it("records the measure option", async () => {
      const report = await runHere({ startChild: answersAsked, measure: ["memory", "time"] });

      expect(report.options.measure).toStrictEqual(["memory", "time"]);
    });

    it("records a relative nodeImport from the config file as written", async () => {
      const report = await runHere({ config: DOT_IMPORT_CONFIG });

      expect(report.options.nodeImport).toBe("./loader.mjs");
    });

    describe("when the OS lists no CPU", () => {
      it("records a null cpu and coreCount", async () => {
        const report = await runHere({ cpus: () => [] });

        expect(report.host).toStrictEqual({
          os: process.platform,
          arch: process.arch,
          cpu: null,
          coreCount: null,
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

  describe("when several cases are selected", () => {
    it("starts one measuring child per case per runtime, runtime by runtime, with the merged minTime and minSampleCount", async () => {
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
        minSampleCount: 9,
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
    ])("asks each measuring child for $why", async ({ callsPerSample, asked }) => {
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
    it("gives a failed result when its child answers with a failure whose cleanup teardown failed too", async () => {
      const error = { phase: "fn", message: "kiwi", stack: "at fn", teardownError: MELON } as const;
      const failsFn = starter(() => ({ status: "failed", error, output: "plum\n" }));

      const report = await runHere({ startChild: failsFn });

      expect(report.results).toMatchObject([
        {
          id: "zeta.bench.ts",
          name: "zeta.bench.ts",
          file: "zeta.bench.ts",
          runtime: { name: "node", version: found("node").version },
          setupPerCall: false,
          status: "failed",
          error: { ...error, output: "plum\n" },
          time: null,
          measurements: [{ repetition: null, orderInRepetition: null, time: null }],
        },
      ]);
    });
  });

  describe("when measure holds memory", () => {
    it.each<{ measure: RunInput["measure"]; asked: { time: boolean; memory: boolean } }>([
      { measure: undefined, asked: { time: true, memory: false } },
      { measure: ["time", "memory"], asked: { time: true, memory: true } },
      { measure: ["memory"], asked: { time: false, memory: true } },
    ])(
      "asks a plain case's one child for $asked under the measure option $measure",
      async ({ measure, asked }) => {
        const requests: unknown[] = [];
        const logsAsked = starter((request) => {
          if (request.mode === "measure")
            requests.push({ time: request.time, memory: request.memory });
          return answered(request);
        });

        await runHere({
          startChild: logsAsked,
          ...(measure === undefined ? {} : { measure }),
        });

        expect(requests).toStrictEqual([asked]);
      },
    );

    it.each<{
      measure: NonNullable<RunInput["measure"]>;
      time: unknown;
      memory: unknown;
      measurement: object;
    }>([
      {
        measure: ["time"],
        time: { unit: "ns/call", median: 4656 },
        memory: null,
        measurement: { time: { ...measured(4656).time, gc: null }, memory: null },
      },
      {
        measure: ["memory"],
        time: null,
        memory: { unit: "B/call", median: 40 },
        measurement: { time: null, memory: memoryOf(40) },
      },
      {
        measure: ["time", "memory"],
        time: { unit: "ns/call", median: 4656 },
        memory: { unit: "B/call", median: 40 },
        measurement: { time: { ...measured(4656).time, gc: null }, memory: memoryOf(40) },
      },
    ])(
      "gives a measured result under the measure option $measure its time $time and memory $memory",
      async ({ measure, time, memory, measurement }) => {
        const report = await runHere({ measure, startChild: answersAsked });

        expect(
          report.results.map((result) => ({
            status: result.status,
            time: result.time,
            memory: result.memory,
            measurements: result.measurements,
          })),
        ).toStrictEqual([
          {
            status: "ok",
            time,
            memory,
            measurements: [{ repetition: null, orderInRepetition: null, ...measurement }],
          },
        ]);
      },
    );

    it("gives a null memory median when the child kept no clean pair", async () => {
      const noCleanPair = starter((request) => answered(request, { memory: null }));

      const report = await runHere({ measure: ["memory"], startChild: noCleanPair });

      expect(
        report.results.map((result) => [result.memory, result.measurements[0].memory]),
      ).toStrictEqual([[{ unit: "B/call", median: null }, memoryOf(null)]]);
    });

    it("gives a failed result a null memory, its measurement too", async () => {
      const failsFn = starter(() => failedOutcome("fn", "kiwi"));

      const report = await runHere({ measure: ["time", "memory"], startChild: failsFn });

      expect(
        report.results.map((result) => [
          result.status,
          result.memory,
          result.measurements[0].memory,
        ]),
      ).toStrictEqual([["failed", null, null]]);
    });

    it("runs memory alone when one of the runtimes has a heap reading", async () => {
      const noHeapOnBun = starter((request, runtime) =>
        runtime.runtime === "bun"
          ? { status: "ok", result: { status: "ok", time: null, memory: null }, output: "" }
          : answered(request),
      );

      const report = await runHere({
        runtimes: ["bun", "node"],
        measure: ["memory"],
        startChild: noHeapOnBun,
      });

      expect({
        statuses: report.results.map((result) => result.status),
        node: report.results.find((result) => result.runtime.name === "node")?.memory,
      }).toStrictEqual({ statuses: ["ok", "ok"], node: { unit: "B/call", median: 40 } });
    });

    it("times a case on runtimes with no heap reading when measure holds time and memory", async () => {
      const report = await runHere({
        runtimes: ["bun"],
        measure: ["time", "memory"],
        startChild: starter((request) =>
          request.mode === "measure" ? answered({ ...request, memory: false }) : answered(request),
        ),
      });

      expect(report.results.map((result) => [result.status, result.memory])).toStrictEqual([
        ["ok", null],
      ]);
    });

    describe("when no runtime has a heap reading and measure holds only memory", () => {
      it("throws a ConfigError naming the runtimes given before any measuring child starts", async () => {
        const result = runHere({
          runtimes: ["bun"],
          measure: ["memory"],
          startChild: startsNoMeasuringChild,
        });

        await expectConfigError(result, ["bun"]);
      });
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

      expect(report.results.map((result) => result.time?.median)).toStrictEqual([0, 1, 2, 3]);
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

      expect(report.results.map((result) => result.time?.median)).toStrictEqual([1]);
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

      expect(events.slice(-5)).toStrictEqual([
        "planned 4",
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
        const packageJson = fixturePath("run", "no-version.json");

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

    it("starts no further child once a child that finished fired it", async () => {
      const controller = new AbortController();
      const measuring: string[] = [];
      const stopAfterZeta = starter((request) => {
        if (request.mode !== "measure") return measuredOutcome(4656);
        measuring.push(request.id);
        if (request.id === "zeta.bench.ts") controller.abort();
        return measuredOutcome(4656);
      });

      const report = await runHere({
        files: ["zeta.bench.ts", "a.bench.ts"],
        signal: controller.signal,
        startChild: stopAfterZeta,
      });

      expect({ interrupted: report.interrupted, measuring }).toStrictEqual({
        interrupted: true,
        measuring: ["zeta.bench.ts"],
      });
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

  it("runs each selected contender once in selection order, forming no repetitions", async () => {
    const outcome = await runOnceHere({
      contestRepetitionCount: 3,
      startChild: listingStarter(
        [APPLE, contender("join"), BANANA, contender("loop")],
        () => ranOnce,
      ),
    });

    expect(outcome.results.map((result) => result.id)).toStrictEqual([
      "apple",
      "concat/join",
      "banana",
      "concat/loop",
    ]);
  });

  it("runs each case once on runtimes with no heap reading when measure holds only memory", async () => {
    const outcome = await runOnceHere({ runtimes: ["bun"], measure: ["memory"] });

    expect(outcome.results.map((result) => [result.runtime, result.status])).toStrictEqual([
      ["bun", "ok"],
    ]);
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

      expect(events.slice(-5)).toStrictEqual(["planned 4", "once", "once", "once", "once"]);
    });
  });
});
