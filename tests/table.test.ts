import { describe, expect, it } from "vitest";

import type { ChildPhase } from "../src/child.js";
import type {
  FailedResult,
  MeasuredProcess,
  MeasuredResult,
  Result,
  ResultError,
} from "../src/report.js";
import { formatTable, metricLine } from "../src/table.js";
import type { StrictOmit } from "../src/utils.js";

type Runtime = Result["runtime"]["name"];
type Stats = MeasuredProcess["stats"];
type ResultBase = StrictOmit<Result, "status" | "error" | "median" | "processes">;

const VERSIONS: Readonly<Record<Runtime, string>> = { node: "24.1.0", bun: "1.3.2" };

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

/** The one process of a measured case, holding `stats`. */
function measuredProcess(stats: Stats): MeasuredProcess {
  return {
    round: 0,
    orderInRound: 0,
    stats,
    sampling: {
      timerResolutionNs: 41.7,
      callsPerSample: 2,
      callsPerSampleFixed: false,
      warmupSamples: 1000,
      timingAttempts: 1,
      timingMs: 1003.4,
    },
    checks: { ratioToEmptyBody: 120.5 },
    gc: null,
    rawSamples: null,
  };
}

/** What every result of case `id` on `runtime` holds, measured or failed. */
function resultBase(id: string, runtime: Runtime): ResultBase {
  return {
    id,
    name: id,
    contender: null,
    params: {},
    file: "fruit.bench.ts",
    runtime: { name: runtime, version: VERSIONS[runtime] },
    setupPerCall: false,
  };
}

/** A result of case `id` measured on `runtime` with `stats`, its median the stats' median. */
function measured(id: string, runtime: Runtime, stats: Stats): MeasuredResult {
  return {
    ...resultBase(id, runtime),
    status: "ok",
    error: null,
    median: stats.median,
    processes: [measuredProcess(stats)],
  };
}

/** A result of case `id` on Node that failed in `phase` with `message`, its cleanup teardown `teardownError`. */
function failed(
  id: string,
  phase: ChildPhase,
  message: string,
  teardownError: ResultError["teardownError"] = null,
): FailedResult {
  return {
    ...resultBase(id, "node"),
    status: "failed",
    error: { phase, message, stack: null, teardownError, output: "" },
    median: null,
    processes: [
      {
        round: 0,
        orderInRound: 0,
        stats: null,
        sampling: null,
        checks: null,
        gc: null,
        rawSamples: null,
      },
    ],
  };
}

/** The lines of the table of `results`. */
function tableLines(results: readonly Result[]): string[] {
  return formatTable(results).split("\n");
}

/** The index of the row of case `id` among `lines`. */
function rowIndex(lines: readonly string[], id: string): number {
  return lines.findIndex((line) => line.trimStart().startsWith(`${id} `));
}

/** The index of the heading of `runtime` among `lines`. */
function headingIndex(lines: readonly string[], runtime: Runtime): number {
  return lines.findIndex((line) => line.includes(runtime) && line.includes(VERSIONS[runtime]));
}

interface Cell {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The cells of a row: runs of text that two or more spaces separate. */
function cells(line: string): Cell[] {
  return [...line.matchAll(/\S+(?: \S+)*/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** The cells of the row of case `id` among `lines`. */
function rowCells(lines: readonly string[], id: string): Cell[] {
  return cells(lines[rowIndex(lines, id)] ?? "");
}

/** The cells of the row of case `id` in the table of `results`, as text. */
function rowTexts(results: readonly Result[], id: string): string[] {
  return rowCells(tableLines(results), id).map((cell) => cell.text);
}

describe("formatTable", () => {
  describe("when there is no result", () => {
    it("returns the empty string", () => {
      const table = formatTable([]);

      expect(table).toBe("");
    });
  });

  describe("when a case was measured", () => {
    it("rows its id, median, mean, min, max and sample count", () => {
      const stats: Stats = {
        min: 700,
        p25: 750,
        median: 812,
        p75: 900,
        p99: 1500,
        max: 2_340_000,
        mean: 4656,
        sampleCount: 1200,
      };

      const row = rowTexts([measured("apple", "node", stats)], "apple");

      expect(row).toStrictEqual(["apple", "812 ns", "4.66 µs", "700 ns", "2.34 ms", "1200"]);
    });
  });

  describe("when formatting a time", () => {
    it.each([
      { ns: 999.7, text: "1.00 µs" },
      { ns: 1_234_500_000_000, text: "1230 s" },
    ])("prints $ns ns as $text", ({ ns, text }) => {
      const row = rowTexts([measured("apple", "node", flatStats(ns))], "apple");

      expect(row[1]).toBe(text);
    });
  });

  describe("when a section holds rows of different widths", () => {
    it("lines up each column across the rows", () => {
      const results = [
        measured("apple", "node", { ...flatStats(812), sampleCount: 64 }),
        measured("elderberry", "node", { ...flatStats(4656), max: 2_340_000, sampleCount: 1200 }),
      ];

      const lines = tableLines(results);

      const rows = ["apple", "elderberry"].map((id) => rowCells(lines, id));
      const aligned = [0, 1, 2, 3, 4, 5].map((column) => {
        const starts = new Set(rows.map((row) => row[column]?.start));
        const ends = new Set(rows.map((row) => row[column]?.end));
        return starts.size === 1 || ends.size === 1;
      });

      expect(rows.map((row) => row.length)).toStrictEqual([6, 6]);
      expect(aligned).toStrictEqual([true, true, true, true, true, true]);
    });
  });

  describe("when results span several runtimes", () => {
    it("sections them per runtime in run order", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        measured("banana", "bun", flatStats(812)),
        measured("cherry", "node", flatStats(812)),
      ];

      const lines = tableLines(results);

      const order = [
        headingIndex(lines, "node"),
        rowIndex(lines, "apple"),
        rowIndex(lines, "cherry"),
        headingIndex(lines, "bun"),
        rowIndex(lines, "banana"),
      ];
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
    });
  });

  describe("when a case failed", () => {
    it("rows its id, its phase and its message", () => {
      const results = [failed("apple", "teardown", "plum exploded")];

      const lines = tableLines(results);

      const row = lines[rowIndex(lines, "apple")];
      expect(row).toMatch(/apple.*teardown.*plum exploded/u);
    });

    it("continues each further line of its message beneath the row", () => {
      const results = [failed("apple", "fn", "plum exploded\nat the stone\n  and the pit")];

      const lines = tableLines(results);

      const row = rowIndex(lines, "apple");
      const indent = " ".repeat(lines[row]?.indexOf("plum exploded") ?? 0);
      expect(lines[row]).toMatch(/plum exploded$/u);
      expect(lines[row + 1]).toBe(`${indent}at the stone`);
      expect(lines[row + 2]).toBe(`${indent}  and the pit`);
    });

    describe("when its cleanup teardown failed too", () => {
      it("continues the row with a labelled line holding the teardown's message", () => {
        const teardownError = { message: "melon split", stack: "at teardown" };
        const results = [failed("apple", "fn", "plum exploded", teardownError)];

        const lines = tableLines(results);

        const row = rowIndex(lines, "apple");
        const indent = " ".repeat(lines[row]?.indexOf("plum exploded") ?? 0);
        expect(lines[row + 1]).toMatch(new RegExp(`^${indent}\\S.* melon split$`, "u"));
      });

      it("continues each further line of the teardown's message beneath its first", () => {
        const teardownError = { message: "melon split\nat the rind", stack: null };
        const results = [failed("apple", "fn", "plum exploded", teardownError)];

        const lines = tableLines(results);

        const row = rowIndex(lines, "apple");
        const teardownLine = lines[row + 1] ?? "";
        expect(teardownLine).toMatch(/\S.* melon split$/u);
        const indent = " ".repeat(teardownLine.indexOf("melon split"));
        expect(lines[row + 2]).toBe(`${indent}at the rind`);
      });
    });

    describe("when its cleanup teardown did not fail", () => {
      it("puts the next row directly beneath it", () => {
        const results = [failed("apple", "fn", "plum exploded"), failed("banana", "fn", "kiwi")];

        const lines = tableLines(results);

        expect(rowIndex(lines, "banana")).toBe(rowIndex(lines, "apple") + 1);
      });
    });
  });
});

describe("metricLine", () => {
  describe("when the case was measured", () => {
    it("names the case and runtime with the median's shortest text", () => {
      const result = measured("apple", "bun", flatStats(812.5));

      const line = metricLine(result);

      expect(line).toBe("METRIC apple/runtime=bun#time=812.5");
    });
  });

  describe("when the case failed", () => {
    it("returns undefined", () => {
      const line = metricLine(failed("apple", "fn", "plum exploded"));

      expect(line).toBeUndefined();
    });
  });
});
