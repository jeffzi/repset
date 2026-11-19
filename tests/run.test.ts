import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FoundRuntime, Outcome } from "../src/children.js";
import { ConfigError } from "../src/options.js";
import type { Report, Result } from "../src/report.js";
import { run, runOnce } from "../src/run.js";
import {
  type Asked,
  type CaseToList,
  failedOutcome,
  findAny,
  found,
  listed,
  listingStarter,
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

/** The contender `key` of the contest `concat`. */
function contender(key: string): CaseToList {
  return { id: `concat/${key}`, setupPerCall: false, name: "concat", contender: key };
}

const APPLE: CaseToList = { id: "apple", setupPerCall: false };
const BANANA: CaseToList = { id: "banana", setupPerCall: false };
const JOIN = contender("join");
const LOOP = contender("loop");
const PLUS = contender("plus");

/** The seed `runCases` draws unless told otherwise. */
const SEED = 20_261_119;

/** Answers a measuring child; `index` counts the measuring children started before it. */
type Answer = (request: Asked, runtime: FoundRuntime, index: number) => Outcome;

/** Runs `cases`, all listed in one file, drawing `SEED`, and logs each measuring child's case id. */
async function runCases(
  cases: CaseToList[],
  input: Partial<RunInput> = {},
  answer: Answer = () => measuredOutcome(4656),
): Promise<{ report: Report; started: string[] }> {
  const started: string[] = [];
  const report = await runHere({
    drawSeed: () => SEED,
    startChild: listingStarter(cases, (request, runtime) => {
      started.push(request.id);
      return answer(request, runtime, started.length - 1);
    }),
    ...input,
  });
  return { report, started };
}

/** `items` cut into consecutive slices of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

/** Each process of `result` as its round, its order in the round and its median. */
function processesOf(result: Result): (number | null)[][] {
  return result.processes.map((process) => [
    process.round,
    process.orderInRound,
    process.stats?.median ?? null,
  ]);
}

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

    it.each([
      { rounds: 5, recorded: 5 },
      { rounds: undefined, recorded: null },
    ])("records the rounds option $rounds as $recorded", async ({ rounds, recorded }) => {
      const report = await runHere(rounds === undefined ? {} : { rounds });

      expect(report.options.rounds).toBe(recorded);
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
        "planned 2",
        "planned 4",
        "measure",
        "measure",
        "measure",
        "measure",
      ]);
    });

    it("counts every round of each contest among the measuring children", async () => {
      const events: string[] = [];

      await runCases([APPLE, JOIN, LOOP], {
        runtimes: ["node", "bun"],
        onPlanned: logsPlans(events),
      });

      expect(events).toStrictEqual(["planned 1", "planned 30"]);
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

  describe("contests", () => {
    it("runs all of a contest's rounds at its first contender's place, one child per contender back to back, on each runtime", async () => {
      const runtimes: string[] = [];

      const { started } = await runCases(
        [APPLE, JOIN, BANANA, LOOP],
        { runtimes: ["bun", "node"], rounds: 2 },
        (_request, runtime) => {
          runtimes.push(runtime.runtime);
          return measuredOutcome(4656);
        },
      );

      const onRuntime = (offset: number): unknown[] => {
        const ids = started.slice(offset, offset + 6);
        return [ids[0], ids.slice(1, 3).toSorted(), ids.slice(3, 5).toSorted(), ids[5]];
      };
      const contest = ["concat/join", "concat/loop"];
      expect({ runtimes, started: [onRuntime(0), onRuntime(6)] }).toStrictEqual({
        runtimes: [...Array<string>(6).fill("bun"), ...Array<string>(6).fill("node")],
        started: [
          ["apple", contest, contest, "banana"],
          ["apple", contest, contest, "banana"],
        ],
      });
    });

    it("runs a lone selected contender once, keeping its contender key, as a plain case", async () => {
      const { report } = await runCases([APPLE, JOIN, LOOP], { filter: "apple|join" });

      expect(
        report.results.map((result) => [
          result.id,
          result.name,
          result.contender,
          processesOf(result),
        ]),
      ).toStrictEqual([
        ["apple", "apple", null, [[1, 1, 4656]]],
        ["concat/join", "concat", "join", [[1, 1, 4656]]],
      ]);
    });

    it.each([
      { contenders: 2, rounds: undefined, expected: 7 },
      { contenders: 3, rounds: undefined, expected: 8 },
      { contenders: 8, rounds: undefined, expected: 12 },
      { contenders: 2, rounds: 3, expected: 3 },
    ])(
      "runs $expected rounds for $contenders contenders when rounds is $rounds",
      async ({ contenders, rounds, expected }) => {
        const cases = Array.from({ length: contenders }, (_, index) =>
          contender(`c${String(index)}`),
        );

        const { report } = await runCases(cases, rounds === undefined ? {} : { rounds });

        expect(report.results.map((result) => result.processes.length)).toStrictEqual(
          Array<number>(contenders).fill(expected),
        );
      },
    );

    it.each([
      { rounds: 3, medians: { "concat/join": 40, "concat/loop": 30 } },
      { rounds: 4, medians: { "concat/join": 30, "concat/loop": 45 } },
    ])(
      "gives each contender one process per round in run order, its median the median of theirs, over $rounds rounds",
      async ({ rounds, medians }) => {
        const byRound: Record<string, number[]> = {
          "concat/join": [50, 10, 40, 20],
          "concat/loop": [30, 60, 5, 70],
        };
        const calls = new Map<string, number>();
        const answer: Answer = (request) => {
          const call = calls.get(request.id) ?? 0;
          calls.set(request.id, call + 1);
          return measuredOutcome(byRound[request.id]?.[call] ?? 0);
        };

        const { report, started } = await runCases([JOIN, LOOP], { rounds }, answer);

        const expectedOf = (id: "concat/join" | "concat/loop"): unknown[] => {
          const orders = started.flatMap((startedId, index) =>
            startedId === id ? [(index % 2) + 1] : [],
          );
          const processes = orders.map((order, round) => [round + 1, order, byRound[id]?.[round]]);
          return [id, "concat", id.slice("concat/".length), medians[id], processes];
        };
        expect(
          report.results
            .toSorted((left, right) => left.id.localeCompare(right.id))
            .map((result) => [
              result.id,
              result.name,
              result.contender,
              result.median,
              processesOf(result),
            ]),
        ).toStrictEqual([expectedOf("concat/join"), expectedOf("concat/loop")]);
      },
    );

    describe("the round orders", () => {
      it("records the seed drawn when the run starts", async () => {
        const { report } = await runCases([JOIN, LOOP], { drawSeed: () => 1234 });

        expect(report.options.seed).toBe(1234);
      });

      it("records a null seed when no contest forms", async () => {
        const { report } = await runCases([APPLE, JOIN, LOOP], { filter: "apple|join" });

        expect(report.options.seed).toBeNull();
      });

      it("repeats for the same seed", async () => {
        const { started: first } = await runCases([JOIN, LOOP, PLUS]);

        const { started: second } = await runCases([JOIN, LOOP, PLUS]);

        expect(second).toStrictEqual(first);
      });

      it("change with the seed", async () => {
        const { started: first } = await runCases([JOIN, LOOP, PLUS]);

        const { started: second } = await runCases([JOIN, LOOP, PLUS], {
          drawSeed: () => SEED + 1,
        });

        expect(second).not.toStrictEqual(first);
      });

      it("are drawn uniformly from the permutations of the contenders", async () => {
        const { started } = await runCases([JOIN, LOOP, PLUS], { rounds: 6000 });

        const counts = Object.values(
          Object.groupBy(chunks(started, 3), (order) => order.join(" ")),
        );
        expect(counts.map((orders) => Math.abs((orders?.length ?? 0) - 1000) < 150)).toStrictEqual(
          Array<boolean>(6).fill(true),
        );
      });
    });

    describe("when a contender's child fails", () => {
      /** Runs `concat` over 4 rounds with `concat/loop` failing in round 2, logging starts and results. */
      async function failLoopInRoundTwo(input: Partial<RunInput> = {}): Promise<{
        report: Report;
        started: string[];
        events: string[];
      }> {
        const events: string[] = [];
        let loopCalls = 0;
        const { report, started } = await runCases(
          [JOIN, LOOP, PLUS],
          {
            ...input,
            rounds: 4,
            onResult: (result) => {
              events.push(`result ${result.id}`);
            },
          },
          (request) => {
            events.push(`start ${request.id}`);
            if (request.id !== "concat/loop") return measuredOutcome(4656);
            loopCalls += 1;
            return loopCalls === 2 ? failedOutcome("fn", "kiwi") : measuredOutcome(17);
          },
        );
        return { report, started, events };
      }

      it("gives it a failed result holding the processes that ran, the failed one last", async () => {
        const { report, started } = await failLoopInRoundTwo();

        const orders = started.flatMap((id, index) =>
          id === "concat/loop" ? [(index % 3) + 1] : [],
        );
        const loop = report.results.find((result) => result.id === "concat/loop");
        expect({
          status: loop?.status,
          error: loop?.error?.message,
          median: loop?.median,
          processes: loop === undefined ? [] : processesOf(loop),
        }).toStrictEqual({
          status: "failed",
          error: "kiwi",
          median: null,
          processes: [
            [1, orders[0], 17],
            [2, orders[1], null],
          ],
        });
      });

      it("emits its result before the next child starts", async () => {
        const { events } = await failLoopInRoundTwo();

        const failedAt = events.lastIndexOf("start concat/loop");
        expect(events[failedAt + 1]).toBe("result concat/loop");
      });

      it("runs it in no later round while the rest run every round", async () => {
        const { started } = await failLoopInRoundTwo();

        expect({
          join: started.filter((id) => id === "concat/join").length,
          loop: started.filter((id) => id === "concat/loop").length,
          plus: started.filter((id) => id === "concat/plus").length,
        }).toStrictEqual({ join: 4, loop: 2, plus: 4 });
      });

      it("gives every contender exactly one result", async () => {
        const { events } = await failLoopInRoundTwo();

        expect({
          join: events.filter((event) => event === "result concat/join").length,
          loop: events.filter((event) => event === "result concat/loop").length,
          plus: events.filter((event) => event === "result concat/plus").length,
        }).toStrictEqual({ join: 1, loop: 1, plus: 1 });
      });

      it("reports its rounds still to come as dropped, once, so planned minus dropped is the children started", async () => {
        const planned: number[] = [];
        const dropped: number[] = [];

        const { started } = await failLoopInRoundTwo({
          onPlanned: (total) => {
            planned.push(total);
          },
          onDropped: (count) => {
            dropped.push(count);
          },
        });

        const left = (planned.at(-1) ?? 0) - dropped.reduce((sum, count) => sum + count, 0);
        expect({ dropped, left }).toStrictEqual({ dropped: [2], left: started.length });
      });
    });

    it("emits each surviving contender's result when the contest's last round ends", async () => {
      const events: string[] = [];

      await runCases(
        [APPLE, JOIN, LOOP, BANANA],
        {
          rounds: 3,
          onResult: (result) => {
            events.push(`result ${result.id}`);
          },
        },
        (request) => {
          events.push(`start ${request.id}`);
          return measuredOutcome(4656);
        },
      );

      expect([
        events.slice(0, 2),
        events.slice(2, 8).map((event) => event.startsWith("start concat/")),
        events.slice(8, 10).toSorted(),
        events.slice(10),
      ]).toStrictEqual([
        ["start apple", "result apple"],
        Array<boolean>(6).fill(true),
        ["result concat/join", "result concat/loop"],
        ["start banana", "result banana"],
      ]);
    });

    describe("when the stop signal fires mid-contest", () => {
      it("keeps the results emitted before it and emits nothing more for the contest", async () => {
        const controller = new AbortController();
        let joinCalls = 0;

        const { report } = await runCases(
          [APPLE, JOIN, LOOP, PLUS],
          { rounds: 3, signal: controller.signal },
          (request) => {
            if (request.id === "concat/loop") return failedOutcome("fn", "kiwi");
            if (request.id === "concat/join") joinCalls += 1;
            if (joinCalls < 2) return measuredOutcome(4656);
            controller.abort();
            return stopped;
          },
        );

        expect({
          interrupted: report.interrupted,
          ids: report.results.map((result) => result.id),
        }).toStrictEqual({ interrupted: true, ids: ["apple", "concat/loop"] });
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

  it("runs each selected contender once in selection order, forming no rounds", async () => {
    const outcome = await runOnceHere({
      rounds: 3,
      startChild: listingStarter([APPLE, JOIN, BANANA, LOOP], () => ranOnce),
    });

    expect(outcome.results.map((result) => result.id)).toStrictEqual([
      "apple",
      "concat/join",
      "banana",
      "concat/loop",
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

      expect(events).toStrictEqual(["planned 2", "planned 4", "once", "once", "once", "once"]);
    });
  });
});
