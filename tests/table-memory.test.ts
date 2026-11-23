import { describe, expect, it } from "vitest";

import type {
  Contest,
  ContestContender,
  FailedResult,
  HeadlineMemory,
  MeasuredResult,
  ReportOptions,
  Result,
} from "../src/report.js";
import { formatTable } from "../src/table.js";
import { found, measured as measuredChild, memoryOf } from "./fake-children.js";

type Runtime = Result["runtime"]["name"];
type Measure = ReportOptions["measure"];
type Stats = NonNullable<MeasuredResult["measurements"][number]["time"]>["stats"];

/** Both measures, time first. */
const BOTH: Measure = ["time", "memory"];

/** The statistics of a case whose every time is `median`, measured over 64 samples. */
function flatStats(median: number): Stats {
  return {
    min: median,
    p25: median,
    median,
    p75: median,
    p99: median,
    max: median,
    mean: median,
    sampleCount: 64,
  };
}

/** A result's memory reading of `median` bytes per call, `null` when no clean pair was kept. */
function bytes(median: number | null): HeadlineMemory {
  return { unit: "B/call", median };
}

/** The runtime entry of a result or contest on `runtime`, at its fake version. */
function runtimeOf(runtime: Runtime): Result["runtime"] {
  return { name: runtime, version: found(runtime).version };
}

/** A result of case `id` on `runtime` with every time `time` (none when null) and the memory reading `memory`. */
function measured(
  id: string,
  [time, memory]: readonly [number | null, HeadlineMemory | null],
  runtime: Runtime = "node",
): MeasuredResult {
  return {
    id,
    name: id,
    contender: null,
    params: {},
    file: "fruit.bench.ts",
    runtime: runtimeOf(runtime),
    setupPerCall: false,
    status: "ok",
    error: null,
    time: time === null ? null : { unit: "ns/call", median: time },
    memory,
    measurements: [
      {
        repetition: null,
        orderInRepetition: null,
        time:
          time === null ? null : { ...measuredChild(time).time, stats: flatStats(time), gc: null },
        memory: memory === null ? null : memoryOf(memory.median),
      },
    ],
  };
}

/** A result of case `id` on Node that failed in `fn` with `message`. */
function failed(id: string, message: string): FailedResult {
  return {
    ...measured(id, [null, null]),
    status: "failed",
    error: { phase: "fn", message, stack: null, teardownError: null, output: "" },
    time: null,
    memory: null,
    measurements: [{ repetition: null, orderInRepetition: null, time: null, memory: null }],
  };
}

/** The result of contender `key` of contest `concat` on Node with the given time and memory. */
function contenderResult(
  key: string,
  readings: readonly [number | null, HeadlineMemory | null],
): MeasuredResult {
  return { ...measured(`concat/${key}`, readings), name: "concat", contender: key };
}

/** Contender `key` of contest `concat` with its median, memory, ratio and rank (null when not judged). */
function contender(
  key: string,
  [time, memory]: readonly [number | null, HeadlineMemory | null],
  [ratio, rank]: readonly [number | null, number | null] = [null, null],
): ContestContender {
  return {
    id: `concat/${key}`,
    time: time === null ? null : { unit: "ns/call", median: time },
    memory,
    ratio,
    rank,
  };
}

/** The entry of contest `concat` on Node over `repetitionCount` repetitions. */
function contest(
  repetitionCount: number,
  contenders: readonly ContestContender[],
  pairs: Contest["pairs"],
): Contest {
  return {
    name: "concat",
    params: {},
    runtime: runtimeOf("node"),
    repetitionCount,
    contenders,
    pairs,
  };
}

/** The lines of the table of `results` and `contests` under `measure`, the last one empty after the closing newline. */
function tableLines(
  results: readonly Result[],
  measure: Measure,
  contests: readonly Contest[] = [],
): string[] {
  return formatTable(results, contests, { color: false, measure }).split("\n");
}

/** The index of the first line that starts with `id` and a space, or -1 when no row does. */
function rowIndex(lines: readonly string[], id: string): number {
  return lines.findIndex((line) => line.startsWith(`${id} `));
}

/** The trimmed cells of `line`, split on ` │ `. */
function cellsOf(line: string | undefined): string[] {
  return (line ?? "").split(" │ ").map((cell) => cell.trim());
}

/** The cells of the row of `id` in `lines` and of the header two lines above it. */
function rowAndHeader(lines: readonly string[], id: string): { row: string[]; header: string[] } {
  const row = rowIndex(lines, id);
  return { row: cellsOf(lines[row]), header: cellsOf(lines[row - 2]) };
}

/** The cells of the row of plain case `apple` on `runtime` measured under `measure` with `memory`. */
function appleRow(measure: Measure, memory: HeadlineMemory | null, runtime: Runtime = "node") {
  const time = measure.includes("time") ? 812 : null;
  return rowAndHeader(tableLines([measured("apple", [time, memory], runtime)], measure), "apple");
}

describe("formatTable", () => {
  describe("when time and memory were measured", () => {
    it("ends a plain case's row in a memory column after the time columns", () => {
      const { row, header } = appleRow(BOTH, bytes(40));

      expect(row).toStrictEqual(["apple", "812 ns", "812 ns", "812 ns", "812 ns", "64", "40.0 B"]);
      expect(header).toHaveLength(row.length);
      expect(header.at(-1)).toBe("memory");
    });

    it.each([
      { median: 4656, text: "4.66 kB", why: "steps to kilobytes at 1000" },
      { median: 2_340_000, text: "2.34 MB", why: "steps to megabytes at a million" },
      { median: 999.7, text: "1.00 kB", why: "rounds up to the next unit" },
      { median: 1_234_500_000, text: "1230 MB", why: "stays in megabytes without exponent form" },
      { median: -4656, text: "-4.66 kB", why: "keeps the sign, stepping on the size" },
    ])("prints $median bytes as $text: $why", ({ median, text }) => {
      const { row } = appleRow(BOTH, bytes(median));

      expect(row.at(-1)).toBe(text);
    });

    it("shows n/a on a Bun row, which has no heap reading", () => {
      const { row } = appleRow(BOTH, null, "bun");

      expect(row.at(-1)).toBe("n/a");
    });

    it("shows no clean pair on a Node row whose reading has no median", () => {
      const { row } = appleRow(BOTH, bytes(null));

      expect(row.at(-1)).toBe("no clean pair");
    });

    it("ends each contender's row in the memory column after its rank", () => {
      const results = [
        contenderResult("join", [100, bytes(40)]),
        contenderResult("loop", [200, bytes(1200)]),
      ];
      const entry = contest(
        8,
        [
          contender("join", [100, bytes(40)], [1, 1]),
          contender("loop", [200, bytes(1200)], [2, 2]),
        ],
        [
          {
            a: "concat/join",
            b: "concat/loop",
            ratio: 2,
            interval: [1.9, 2.1],
            p: 0.01,
            pAdjusted: 0.01,
            faster: "concat/join",
            tie: null,
          },
        ],
      );

      const lines = tableLines(results, BOTH, [entry]);

      const join = rowAndHeader(lines, "join");
      expect([join.row, cellsOf(lines[rowIndex(lines, "loop")])]).toStrictEqual([
        ["join", "100 ns", "1.00×", "1", "40.0 B"],
        ["loop", "200 ns", "2.00×", "2", "1.20 kB"],
      ]);
      expect(join.header.at(-1)).toBe("memory");
    });
  });

  describe("when memory was measured alone", () => {
    it("rows a plain case's id and memory reading only", () => {
      const { row, header } = appleRow(["memory"], bytes(40));

      expect(row).toStrictEqual(["apple", "40.0 B"]);
      expect(header).toHaveLength(2);
      expect(header.at(-1)).toBe("memory");
    });

    it("lists each contender's memory reading only, with no not judged line and no footer", () => {
      const results = [
        contenderResult("join", [null, bytes(40)]),
        contenderResult("loop", [null, bytes(1200)]),
      ];
      const entry = contest(
        1,
        [contender("join", [null, bytes(40)]), contender("loop", [null, bytes(1200)])],
        [],
      );

      const lines = tableLines(results, ["memory"], [entry]);

      const loop = rowIndex(lines, "loop");
      expect([cellsOf(lines[rowIndex(lines, "join")]), cellsOf(lines[loop])]).toStrictEqual([
        ["join", "40.0 B"],
        ["loop", "1.20 kB"],
      ]);
      expect(lines.slice(loop + 1)).toStrictEqual([""]);
    });
  });

  describe("when a case failed", () => {
    it.each([{ measure: ["memory"] as const }, { measure: BOTH }])(
      "rows it as when time alone was measured, under $measure",
      ({ measure }) => {
        const failure = failed("watermelons", "plum exploded\nat the stone");
        const failedRows = (lines: readonly string[]): string[] => {
          const row = rowIndex(lines, "watermelons");
          return lines.slice(row, lines.indexOf("", row));
        };
        const timeAlone = failedRows(
          tableLines([measured("apple", [812, null]), failure], ["time"]),
        );
        const time = measure.includes("time") ? 812 : null;

        const lines = tableLines([measured("apple", [time, bytes(40)]), failure], measure);

        expect(timeAlone).toHaveLength(2);
        expect(failedRows(lines)).toStrictEqual(timeAlone);
      },
    );
  });
});
