import { describe, expect, it } from "vitest";

import type { HeadlineMemory, ReportOptions } from "../src/report.js";
import {
  bytesPerCall,
  cellsOf,
  contender,
  contenderResult,
  contest,
  flatStats,
  measured,
  rowIndex,
  type Runtime,
  tableLines,
} from "./helpers/report-results.js";

type Measure = ReportOptions["measure"];

/** Both measures, time first. */
const BOTH: Measure = ["time", "memory"];

/** The cells of the row of `id` in `lines` and of the header two lines above it. */
function rowAndHeader(lines: readonly string[], id: string): { row: string[]; header: string[] } {
  const row = rowIndex(lines, id);
  return { row: cellsOf(lines[row]), header: cellsOf(lines[row - 2]) };
}

/** The cells of the row of plain case `apple` on `runtime` measured under `measure` with `memory`. */
function appleRow(measure: Measure, memory: HeadlineMemory | null, runtime: Runtime = "node") {
  const stats = measure.includes("time") ? flatStats(812) : null;
  return rowAndHeader(
    tableLines([measured("apple", runtime, stats, memory)], [], { measure }),
    "apple",
  );
}

/** The table lines of the contest `concat` of `join` (40 B) and `loop` (1200 B) under memory alone. */
function memoryAloneContestLines(): string[] {
  const results = [
    contenderResult("concat", "join", null, { memory: bytesPerCall(40) }),
    contenderResult("concat", "loop", null, { memory: bytesPerCall(1200) }),
  ];
  const entry = contest(
    "concat",
    1,
    [
      { ...contender("concat/join", null), memory: bytesPerCall(40) },
      { ...contender("concat/loop", null), memory: bytesPerCall(1200) },
    ],
    [],
  );
  return tableLines(results, [entry], { measure: ["memory"] });
}

describe("formatTable", () => {
  describe("when time and memory were measured", () => {
    it("ends a plain case's row in a memory column after the time columns", () => {
      const { row, header } = appleRow(BOTH, bytesPerCall(40));

      expect(row).toStrictEqual(["apple", "812 ns", "812 ns", "812 ns", "812 ns", "64", "40.0 B"]);
      expect(header).toHaveLength(row.length);
    });

    it("prints -4656 bytes as -4.66 kB, keeping the sign, stepping on the size", () => {
      const { row } = appleRow(BOTH, bytesPerCall(-4656));

      expect(row.at(-1)).toBe("-4.66 kB");
    });

    it("shows n/a on a Bun row, which has no heap reading", () => {
      const { row } = appleRow(BOTH, null, "bun");

      expect(row.at(-1)).toBe("n/a");
    });

    it("shows no clean pair on a Node row whose reading has no median", () => {
      const { row } = appleRow(BOTH, bytesPerCall(null));

      expect(row.at(-1)).toBe("no clean pair");
    });

    it("ends each contender's row in the memory column after its rank", () => {
      const results = [
        contenderResult("concat", "join", 100, { memory: bytesPerCall(40) }),
        contenderResult("concat", "loop", 200, { memory: bytesPerCall(1200) }),
      ];
      const entry = contest(
        "concat",
        8,
        [
          { ...contender("concat/join", 100, 1, 1), memory: bytesPerCall(40) },
          { ...contender("concat/loop", 200, 2, 2), memory: bytesPerCall(1200) },
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

      const lines = tableLines(results, [entry], { measure: BOTH });

      expect([
        cellsOf(lines[rowIndex(lines, "join")]),
        cellsOf(lines[rowIndex(lines, "loop")]),
      ]).toStrictEqual([
        ["join", "100 ns", "1.00×", "1", "40.0 B"],
        ["loop", "200 ns", "2.00×", "2", "1.20 kB"],
      ]);
    });
  });

  describe("when memory was measured alone", () => {
    it("rows a plain case's id and memory reading only", () => {
      const { row, header } = appleRow(["memory"], bytesPerCall(40));

      expect(row).toStrictEqual(["apple", "40.0 B"]);
      expect(header).toHaveLength(2);
    });

    it("lists each contender's memory reading only", () => {
      const lines = memoryAloneContestLines();

      expect([
        cellsOf(lines[rowIndex(lines, "join")]),
        cellsOf(lines[rowIndex(lines, "loop")]),
      ]).toStrictEqual([
        ["join", "40.0 B"],
        ["loop", "1.20 kB"],
      ]);
    });

    it("ends the table at the last contender's memory row, with no not judged line or footer", () => {
      const lines = memoryAloneContestLines();

      expect(lines.slice(rowIndex(lines, "loop") + 1)).toStrictEqual([""]);
    });
  });
});
