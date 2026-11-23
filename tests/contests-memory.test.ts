import { describe, expect, it } from "vitest";

import type { MeasureRequest } from "../src/child-protocol.js";
import type { Outcome } from "../src/children.js";
import type { Report, Result } from "../src/report.js";
import {
  answered,
  APPLE,
  type Asked,
  type CaseToList,
  contender,
  failedOutcome,
  found,
  listingStarter,
  memoryOf,
} from "./fake-children.js";
import { type RunInput, runHere } from "./run-here.js";

const JOIN = contender("join");
const LOOP = contender("loop");
const PLUS = contender("plus");

const NODE = { name: "node", version: found("node").version };

/** Answers a measuring child's request; `call` counts the earlier requests for the same case. */
type Answer = (request: MeasureRequest, call: number) => Outcome;

/** Runs `cases`, all listed in one file, under `input`, logging each measuring request in start order. */
async function runCases(
  cases: readonly CaseToList[],
  input: Partial<RunInput>,
  answer: Answer = (request) => answered(request),
): Promise<{ report: Report; asked: MeasureRequest[] }> {
  const asked: MeasureRequest[] = [];
  const report = await runHere({
    drawSeed: () => 20_261_119,
    startChild: listingStarter([...cases], (request: Asked) => {
      if (request.mode !== "measure") throw new Error(`a ${request.mode} child started`);
      const call = asked.filter((earlier) => earlier.id === request.id).length;
      asked.push(request);
      return answer(request, call);
    }),
    ...input,
  });
  return { report, asked };
}

/** The result of case `id` in `report`. */
function resultOf(report: Report, id: string): Result | undefined {
  return report.results.find((result) => result.id === id);
}

/** The headline memory of a case whose median is `median` bytes per call. */
function bytesPerCall(median: number | null): { unit: "B/call"; median: number | null } {
  return { unit: "B/call", median };
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

describe("run", () => {
  describe("when a contest runs with measure holding time and memory", () => {
    const BOTH: Partial<RunInput> = { measure: ["time", "memory"], contestRepetitionCount: 3 };

    it("asks each contender's repetition-1 child alone for memory, and every child for time", async () => {
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

    it("gives each contender in contests[] its result's memory, ranking and pairing by time alone", async () => {
      const { report } = await runCases(
        [JOIN, LOOP],
        { measure: ["time", "memory"], contestRepetitionCount: 7 },
        readsPerContender({ join: 80, loop: 40 }, { join: 100, loop: 200 }),
      );

      const entry = report.contests[0];
      expect({
        contenders: entry?.contenders.map(({ id, time, memory, rank }) => ({
          id,
          time: time?.median,
          memory,
          rank,
        })),
        pairs: entry?.pairs.map(({ a, b, faster }) => [a, b, faster]),
      }).toStrictEqual({
        contenders: [
          { id: "concat/join", time: 100, memory: bytesPerCall(80), rank: 1 },
          { id: "concat/loop", time: 200, memory: bytesPerCall(40), rank: 2 },
        ],
        pairs: [["concat/join", "concat/loop", "concat/join"]],
      });
    });

    describe("when a contender's repetition-1 pass fails", () => {
      it("fails it in the pass's phase, runs it in no later repetition, and ranks the rest", async () => {
        const timed = readsPerContender({}, { join: 100, plus: 200 });

        const { report, asked } = await runCases(
          [JOIN, LOOP, PLUS],
          { measure: ["time", "memory"], contestRepetitionCount: 7 },
          (request, call) =>
            request.id === "concat/loop" && request.memory
              ? failedOutcome("setup", "kiwi")
              : timed(request, call),
        );

        const loop = resultOf(report, "concat/loop");
        expect({
          loop: [loop?.status, loop?.error?.phase, loop?.memory],
          loopStarts: asked.filter((request) => request.id === "concat/loop").length,
          ranked: report.contests[0]?.contenders.map(({ id, rank }) => [id, rank]),
        }).toStrictEqual({
          loop: ["failed", "setup", null],
          loopStarts: 1,
          ranked: [
            ["concat/join", 1],
            ["concat/plus", 2],
            ["concat/loop", null],
          ],
        });
      });
    });

    describe("when a contender fails in a later repetition", () => {
      it("gives it a null memory, in results and in contests[]", async () => {
        const { report } = await runCases([JOIN, LOOP], BOTH, (request, call) =>
          request.id === "concat/loop" && call === 1
            ? failedOutcome("fn", "kiwi")
            : answered(request),
        );

        expect({
          result: resultOf(report, "concat/loop")?.memory,
          contest: report.contests[0]?.contenders.map(({ id, memory }) => [id, memory]),
        }).toStrictEqual({
          result: null,
          contest: [
            ["concat/join", bytesPerCall(40)],
            ["concat/loop", null],
          ],
        });
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

    it("gives each contender one measurement in repetition 1, with no time", async () => {
      const { report } = await runCases([JOIN, LOOP], MEMORY_ONLY);

      expect(
        report.results.map((result) => [
          result.id,
          result.time,
          result.measurements.map(({ repetition, orderInRepetition, time, memory }) => ({
            repetition,
            ordered: orderInRepetition === 1 || orderInRepetition === 2,
            time,
            memory,
          })),
        ]),
      ).toStrictEqual(
        ["concat/join", "concat/loop"].map((id) => [
          id,
          null,
          [{ repetition: 1, ordered: true, time: null, memory: memoryOf(40) }],
        ]),
      );
    });

    it("records a one-repetition contest entry with each contender's memory and no time, ratio, rank or pair", async () => {
      const { report } = await runCases(
        [JOIN, LOOP],
        MEMORY_ONLY,
        readsPerContender({ join: 80, loop: 40 }),
      );

      const sorted = report.contests.map((entry) =>
        Object.assign({}, entry, {
          contenders: entry.contenders.toSorted((left, right) => left.id.localeCompare(right.id)),
        }),
      );

      expect(sorted).toStrictEqual([
        {
          name: "concat",
          params: {},
          runtime: NODE,
          repetitionCount: 1,
          contenders: [
            { id: "concat/join", time: null, memory: bytesPerCall(80), ratio: null, rank: null },
            { id: "concat/loop", time: null, memory: bytesPerCall(40), ratio: null, rank: null },
          ],
          pairs: [],
        },
      ]);
    });
  });

  describe("onPlanned", () => {
    it.each<{ measure: NonNullable<RunInput["measure"]>; total: number }>([
      { measure: ["time"], total: 7 },
      { measure: ["time", "memory"], total: 7 },
      { measure: ["memory"], total: 3 },
    ])(
      "receives $total children under the measure option $measure, as many as start",
      async ({ measure, total }) => {
        const planned: number[] = [];

        const { asked } = await runCases([APPLE, JOIN, LOOP], {
          measure,
          contestRepetitionCount: 3,
          onPlanned: (count) => {
            planned.push(count);
          },
        });

        expect({ planned: planned.at(-1), started: asked.length }).toStrictEqual({
          planned: total,
          started: total,
        });
      },
    );
  });
});
