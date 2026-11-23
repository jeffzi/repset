import { describe, expect, it } from "vitest";

import type { Report, Result } from "../src/report.js";
import { answered, APPLE, failedOutcome, memoryOf } from "./fake-children.js";
import { type Answer, JOIN, LOOP, type RunInput, runCases } from "./run-here.js";

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
