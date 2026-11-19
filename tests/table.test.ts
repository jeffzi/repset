import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import type { ChildPhase } from "../src/child.js";
import type { StrictOmit } from "../src/command-line.js";
import type {
  FailedResult,
  MeasuredProcess,
  MeasuredResult,
  Result,
  ResultError,
} from "../src/report.js";
import { formatTable, metricLine } from "../src/table.js";
import { found, measured as measuredChild } from "./fake-children.js";

type Runtime = Result["runtime"]["name"];
type Stats = MeasuredProcess["stats"];
type ResultBase = StrictOmit<Result, "status" | "error" | "median" | "processes">;

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
    sampling: measuredChild(stats.median).sampling,
    checks: measuredChild(stats.median).checks,
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
    runtime: { name: runtime, version: found(runtime).version },
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

/** The lines of the table of `results`, the last one empty after the closing newline. */
function tableLines(results: readonly Result[]): string[] {
  return formatTable(results).split("\n");
}

/** The index of the first line that starts with `id` and a space, or -1 when no row does. */
function rowIndex(lines: readonly string[], id: string): number {
  return lines.findIndex((line) => line.startsWith(`${id} `));
}

/** A rule of `─` whose runs have the given lengths, `junction` between them. */
function rule(junction: string, runs: readonly number[]): string {
  return runs.map((run) => "─".repeat(run)).join(junction);
}

/** The index of the first line naming `runtime` and its version, or -1 when none does. */
function headingIndex(lines: readonly string[], runtime: Runtime): number {
  return lines.findIndex((line) => line.includes(runtime) && line.includes(found(runtime).version));
}

/** The trimmed cells of the row of case `id` in the table of `results`, split on ` │ `. */
function rowTexts(results: readonly Result[], id: string): string[] {
  const lines = tableLines(results);
  return (lines[rowIndex(lines, id)] ?? "").split(" │ ").map((cell) => cell.trim());
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

  describe("when a time reaches the top of its unit", () => {
    it.each([
      { ns: 999.7, text: "1.00 µs", why: "rounds up to the next unit" },
      { ns: 1_234_500_000_000, text: "1230 s", why: "stays in seconds without exponent form" },
    ])("prints $ns ns as $text: $why", ({ ns, text }) => {
      const row = rowTexts([measured("apple", "node", flatStats(ns))], "apple");

      expect(row[1]).toBe(text);
    });
  });

  describe("when a section's ids are shorter than its header", () => {
    it("pads the id column to the header", () => {
      const results = [measured("nut", "bun", flatStats(812))];

      const lines = tableLines(results);

      expect(lines[rowIndex(lines, "nut")]).toBe(
        "nut  │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
      );
    });
  });

  describe("when a failed row holds a section's longest id", () => {
    it("boxes the section with every row padded to that id", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        measured("elderberry", "node", { ...flatStats(4656), max: 2_340_000, sampleCount: 1200 }),
        failed("watermelons", "fn", "plum exploded"),
        failed("fig", "fn", "kiwi"),
      ];

      const lines = tableLines(results);

      expect(lines).toStrictEqual([
        "node 24.1.0",
        rule("┬", [12, 9, 9, 9, 9, 8]),
        "case        │  median │    mean │     min │     max │ samples",
        rule("┼", [12, 9, 9, 9, 9, 8]),
        "apple       │  812 ns │  812 ns │  812 ns │  812 ns │      64",
        "elderberry  │ 4.66 µs │ 4.66 µs │ 4.66 µs │ 2.34 ms │    1200",
        expect.stringMatching(/^watermelons │ \S.* plum exploded$/u),
        expect.stringMatching(/^fig {9}│ \S.* kiwi$/u),
        "",
        expect.any(String),
        "",
      ]);
    });
  });

  describe("when results span several runtimes", () => {
    it("separates the sections with one blank line", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        measured("nut", "bun", flatStats(812)),
      ];

      const lines = tableLines(results);

      expect(lines).toStrictEqual([
        "node 24.1.0",
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        "",
        "bun 1.3.2",
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        "",
        expect.any(String),
        "",
      ]);
    });

    it("sizes each section's columns to its own rows", () => {
      const results = [
        measured("elderberry", "node", { ...flatStats(4656), max: 2_340_000, sampleCount: 1200 }),
        measured("banana", "bun", flatStats(812)),
      ];

      const lines = tableLines(results);

      expect(lines[rowIndex(lines, "banana")]).toBe(
        "banana │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
      );
    });

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
      const indent = " ".repeat((lines[row]?.indexOf("│") ?? 0) + 2);
      expect(lines[row]).toMatch(/^apple │ \S.*plum exploded$/u);
      expect(lines[row + 1]).toBe(`${indent}at the stone`);
      expect(lines[row + 2]).toBe(`${indent}  and the pit`);
    });

    describe("when its cleanup teardown failed too", () => {
      it("continues the row with a labelled line holding the teardown's message", () => {
        const teardownError = { message: "melon split", stack: "at teardown" };
        const results = [failed("apple", "fn", "plum exploded", teardownError)];

        const lines = tableLines(results);

        const row = rowIndex(lines, "apple");
        const indent = " ".repeat((lines[row]?.indexOf("│") ?? 0) + 2);
        expect(lines[row + 1]).toMatch(new RegExp(`^${indent}\\S.* melon split$`, "u"));
      });

      it("continues each further line of the teardown's message beneath its first", () => {
        const teardownError = { message: "melon split\ninto halves", stack: "at teardown" };
        const results = [failed("apple", "fn", "plum exploded", teardownError)];

        const lines = tableLines(results);

        const labelled = rowIndex(lines, "apple") + 1;
        const indent = " ".repeat(lines[labelled]?.indexOf("melon split") ?? 0);
        expect(lines[labelled + 1]).toBe(`${indent}into halves`);
      });
    });
  });

  describe("when colored", () => {
    const results = [
      measured("elderberry", "node", { ...flatStats(4656), max: 2_340_000, sampleCount: 1200 }),
      failed("fig", "fn", "kiwi\nplum", { message: "melon split", stack: "at teardown" }),
      measured("banana", "bun", flatStats(812)),
    ];

    it("styles the table", () => {
      const plain = formatTable(results);

      const colored = formatTable(results, { color: true });

      expect(colored).not.toBe(plain);
    });

    it("keeps the visible text equal to the plain table", () => {
      const plain = formatTable(results);

      const colored = formatTable(results, { color: true });

      expect(stripVTControlCharacters(colored)).toBe(plain);
    });
  });
});

describe("metricLine", () => {
  describe("when the case was measured", () => {
    it("names the case and runtime with the median's shortest text", () => {
      const result = measured("apple", "bun", flatStats(812.5));

      const line = metricLine(result);

      expect(line).toMatch(/\bapple\b.*\bbun\b.*\b812\.5$/u);
    });
  });

  describe("when the case failed", () => {
    it("returns undefined", () => {
      const line = metricLine(failed("apple", "fn", "plum exploded"));

      expect(line).toBeUndefined();
    });
  });
});
