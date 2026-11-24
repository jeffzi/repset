import { describe, expect, it } from "vitest";

import type { Report, Result } from "../src/report.js";
import {
  answered,
  APPLE,
  BANANA,
  type CaseToList,
  contender,
  failedOutcome,
  failsLoopInRepetitionTwo,
  listingStarter,
  measuredOutcome,
  memoryOf,
  stopped,
} from "./helpers/fake-children.js";
import { repeated } from "./helpers/repeated.js";
import { bytesPerCall, nsPerCall } from "./helpers/report-results.js";
import { type Answer, JOIN, LOOP, PLUS, type RunInput, runCases } from "./helpers/run-here.js";

/** Each measurement of `result` as its repetition, its order in the repetition and its median. */
function measurementsOf(result: Result): (number | null)[][] {
  return result.measurements.map((measurement) => [
    measurement.repetition,
    measurement.orderInRepetition,
    measurement.time?.stats.median ?? null,
  ]);
}

/** The result of case `id` in `report`. */
function resultOf(report: Report, id: string): Result | undefined {
  return report.results.find((result) => result.id === id);
}

/** An answer reading `memory` bytes per call for each contender key, and the time medians `time` gives per key. */
function readsPerContender(
  memory: Readonly<Record<string, number>>,
  time: Readonly<Record<string, number>> = {},
): Answer {
  return (request) => {
    const key = request.id.slice("concat/".length);
    return answered(request, { time: time[key] ?? 4656, memory: memory[key] ?? 40 });
  };
}

/** What a contender's child answers in one repetition: its median, or `null` to fail. */
type Answered = number | null;

/** How many entries of `items` equal `item`. */
function countOf(items: readonly string[], item: string): number {
  return items.filter((candidate) => candidate === item).length;
}

/** Runs the contest `concat`, its contenders listed in key order, each child answered by repetition. */
async function judge(
  byRepetition: Readonly<Record<string, readonly Answered[]>>,
  input: Partial<RunInput> = {},
  cases: readonly CaseToList[] = Object.keys(byRepetition).map((key) => contender(key)),
): Promise<Report> {
  const { report } = await runCases(cases, input, (request, call) => {
    const scheduled = byRepetition[request.id.slice("concat/".length)]?.[call];
    const median = scheduled === undefined ? 4656 : scheduled;
    if (median === null) return failedOutcome("fn", "kiwi");
    return measuredOutcome(median);
  });
  return report;
}

describe("run", () => {
  describe("when a contest runs", () => {
    it.each([
      { repetitions: 3, medians: { "concat/join": 40, "concat/loop": 30 } },
      { repetitions: 4, medians: { "concat/join": 30, "concat/loop": 45 } },
    ])(
      "gives each contender one measurement per repetition in run order, its median the median of theirs, over $repetitions repetitions",
      async ({ repetitions, medians }) => {
        const byRepetition: Record<string, number[]> = {
          "concat/join": [50, 10, 40, 20],
          "concat/loop": [30, 60, 5, 70],
        };
        const answer: Answer = (request, call) => {
          return measuredOutcome(byRepetition[request.id]?.[call] ?? 0);
        };

        const { report, started } = await runCases(
          [JOIN, LOOP],
          { contestRepetitionCount: repetitions },
          answer,
        );

        const expectedOf = (id: "concat/join" | "concat/loop"): unknown[] => {
          const orders = started.flatMap((startedId, index) =>
            startedId === id ? [(index % 2) + 1] : [],
          );
          const measurements = orders.map((order, repetition) => [
            repetition + 1,
            order,
            byRepetition[id]?.[repetition],
          ]);
          return [id, "concat", id.slice("concat/".length), nsPerCall(medians[id]), measurements];
        };
        expect(
          report.results
            .toSorted((left, right) => left.id.localeCompare(right.id))
            .map((result) => [
              result.id,
              result.name,
              result.contender,
              result.time,
              measurementsOf(result),
            ]),
        ).toStrictEqual([expectedOf("concat/join"), expectedOf("concat/loop")]);
      },
    );

    describe("when the repetition orders are drawn", () => {
      it("records the seed drawn when the run starts", async () => {
        const { report } = await runCases([JOIN, LOOP], { drawSeed: () => 1234 });

        expect(report.options.seed).toBe(1234);
      });

      it("records a null seed when no contest forms", async () => {
        const { report } = await runCases([APPLE, JOIN, LOOP], { filter: "apple|join" });

        expect(report.options.seed).toBeNull();
      });
    });

    describe("when a contender's child fails", () => {
      /** Runs `concat` over 4 repetitions with `concat/loop` failing in repetition 2, logging starts and results. */
      async function runWithLoopFailingInRepetitionTwo(input: Partial<RunInput> = {}): Promise<{
        report: Report;
        started: string[];
        events: string[];
      }> {
        const events: string[] = [];
        const answer = failsLoopInRepetitionTwo();
        const { report, started } = await runCases(
          [JOIN, LOOP, PLUS],
          {
            ...input,
            contestRepetitionCount: 4,
            onResult: (result) => {
              events.push(`result ${result.id}`);
            },
          },
          (request) => {
            events.push(`start ${request.id}`);
            return answer(request);
          },
        );
        return { report, started, events };
      }

      it("gives it a failed result holding the measurements that ran, the failed one last", async () => {
        const { report, started } = await runWithLoopFailingInRepetitionTwo();

        const orders = started.flatMap((id, index) =>
          id === "concat/loop" ? [(index % 3) + 1] : [],
        );
        const loop = report.results.find((result) => result.id === "concat/loop");
        expect({
          status: loop?.status,
          error: loop?.error?.message,
          time: loop?.time,
          measurements: loop === undefined ? [] : measurementsOf(loop),
        }).toStrictEqual({
          status: "failed",
          error: "kiwi",
          time: null,
          measurements: [
            [1, orders[0], 17],
            [2, orders[1], null],
          ],
        });
      });

      it("emits its result before the next child starts", async () => {
        const { events } = await runWithLoopFailingInRepetitionTwo();

        const failedAt = events.lastIndexOf("start concat/loop");
        expect(events[failedAt + 1]).toBe("result concat/loop");
      });

      it("gives every contender exactly one result", async () => {
        const { events } = await runWithLoopFailingInRepetitionTwo();

        expect({
          join: countOf(events, "result concat/join"),
          loop: countOf(events, "result concat/loop"),
          plus: countOf(events, "result concat/plus"),
        }).toStrictEqual({ join: 1, loop: 1, plus: 1 });
      });
    });

    it("emits each surviving contender's result when the contest's last repetition ends", async () => {
      const events: string[] = [];

      await runCases(
        [APPLE, JOIN, LOOP, BANANA],
        {
          contestRepetitionCount: 3,
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
          { contestRepetitionCount: 3, signal: controller.signal },
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

  describe("when a contest is judged", () => {
    describe("when a contender fails", () => {
      it("lists the failed contenders after the survivor, in results order", async () => {
        const report = await judge({ join: [100, null], loop: [null], plus: repeated(200, 8) });

        expect(report.contests[0]?.contenders.map(({ id }) => id)).toStrictEqual([
          "concat/plus",
          "concat/loop",
          "concat/join",
        ]);
      });
    });

    describe("when every contender fails", () => {
      it("is recorded before onResult receives the last failed result", async () => {
        const seen: string[][] = [];

        await judge(
          { join: [null], loop: [null] },
          {
            onResult: (_result, contests) => {
              seen.push(contests.map((entry) => entry.name));
            },
          },
        );

        expect(seen).toStrictEqual([[], ["concat"]]);
      });
    });

    it("is recorded once per contest and runtime, never for a plain case", async () => {
      const report = await judge({}, { runtimes: ["node", "bun"], contestRepetitionCount: 2 }, [
        APPLE,
        JOIN,
        LOOP,
      ]);

      expect(report.contests.map((entry) => [entry.name, entry.runtime.name])).toStrictEqual([
        ["concat", "node"],
        ["concat", "bun"],
      ]);
    });

    describe("when the stop signal fires mid-contest", () => {
      it("is dropped, keeping the entries of the contests that finished", async () => {
        const controller = new AbortController();
        const stopsOnBun = listingStarter([JOIN, LOOP], (_request, runtime) => {
          if (runtime.runtime === "node") return measuredOutcome(4656);
          controller.abort();
          return stopped;
        });

        const { report } = await runCases([JOIN, LOOP], {
          runtimes: ["node", "bun"],
          contestRepetitionCount: 2,
          signal: controller.signal,
          startChild: stopsOnBun,
        });

        expect({
          interrupted: report.interrupted,
          runtimes: report.contests.map((entry) => entry.runtime.name),
        }).toStrictEqual({ interrupted: true, runtimes: ["node"] });
      });
    });
  });

  describe("when a contest runs with measure holding time and memory", () => {
    const BOTH: Partial<RunInput> = { measure: ["time", "memory"], contestRepetitionCount: 3 };

    it("asks for memory only in each contender's first repetition", async () => {
      const { asked } = await runCases([JOIN, LOOP], BOTH);

      const byId = Object.groupBy(asked, (request) => request.id);
      expect({
        join: byId["concat/join"]?.map(({ time, memory }) => [time, memory]),
        loop: byId["concat/loop"]?.map(({ time, memory }) => [time, memory]),
      }).toStrictEqual({
        join: [
          [true, true],
          [true, false],
          [true, false],
        ],
        loop: [
          [true, true],
          [true, false],
          [true, false],
        ],
      });
    });

    it("gives each contender its repetition-1 memory as its result's, its later measurements none", async () => {
      const { report } = await runCases(
        [JOIN, LOOP],
        BOTH,
        readsPerContender({ join: 40, loop: 80 }),
      );

      expect(
        ["concat/join", "concat/loop"].map((id) => {
          const result = resultOf(report, id);
          return [result?.memory, result?.measurements.map((measurement) => measurement.memory)];
        }),
      ).toStrictEqual([
        [bytesPerCall(40), [memoryOf(40), null, null]],
        [bytesPerCall(80), [memoryOf(80), null, null]],
      ]);
    });

    describe("when a contender fails in a later repetition", () => {
      it("gives it a null memory", async () => {
        const { report } = await runCases([JOIN, LOOP], BOTH, (request, call) =>
          request.id === "concat/loop" && call === 1
            ? failedOutcome("fn", "kiwi")
            : answered(request),
        );

        expect(resultOf(report, "concat/loop")?.memory).toBeNull();
      });
    });
  });

  describe("when a contest runs with measure holding only memory", () => {
    const MEMORY_ONLY: Partial<RunInput> = { measure: ["memory"], contestRepetitionCount: 5 };

    it("starts one child per contender, asking it for memory alone", async () => {
      const { asked } = await runCases([JOIN, LOOP], MEMORY_ONLY);

      expect(
        asked
          .map(({ id, time, memory }) => [id, time, memory] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toStrictEqual([
        ["concat/join", false, true],
        ["concat/loop", false, true],
      ]);
    });
  });

  describe("onPlanned", () => {
    it("receives one child per case under the measure option memory alone, as many as start", async () => {
      const planned: number[] = [];

      const { asked } = await runCases([APPLE, JOIN, LOOP], {
        measure: ["memory"],
        contestRepetitionCount: 3,
        onPlanned: (count) => {
          planned.push(count);
        },
      });

      expect({ planned: planned.at(-1), started: asked.length }).toStrictEqual({
        planned: 3,
        started: 3,
      });
    });
  });
});
