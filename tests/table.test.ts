import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import type { ChildPhase } from "../src/child.js";
import type { StrictOmit } from "../src/command-line.js";
import type {
  Contest,
  ContestContender,
  ContestPair,
  FailedResult,
  MeasuredProcess,
  MeasuredResult,
  Result,
  ResultError,
} from "../src/report.js";
import { failureLines, formatTable, paint, visibleWidth } from "../src/table.js";
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

/** Statistics whose max and sample count print wider than the rest. */
const WIDE_STATS: Stats = { ...flatStats(4656), max: 2_340_000, sampleCount: 1200 };

/** The one process of a measured case, holding `stats`. */
function measuredProcess(stats: Stats): MeasuredProcess {
  const { sampling, checks } = measuredChild(stats.median);
  return {
    round: 0,
    orderInRound: 0,
    stats,
    sampling,
    checks,
    gc: null,
    rawSamples: null,
  };
}

/** The runtime entry of a result or contest on `runtime`, at its fake version. */
function runtimeOf(runtime: Runtime): Result["runtime"] {
  return { name: runtime, version: found(runtime).version };
}

/** What every result of case `id` on `runtime` holds, measured or failed. */
function resultBase(id: string, runtime: Runtime): ResultBase {
  return {
    id,
    name: id,
    contender: null,
    params: {},
    file: "fruit.bench.ts",
    runtime: runtimeOf(runtime),
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

/** A result of contender `key` of contest `name` measured on `runtime` with every time `median`. */
function contenderResult(
  name: string,
  key: string,
  median: number,
  runtime: Runtime = "node",
): MeasuredResult {
  return { ...measured(`${name}/${key}`, runtime, flatStats(median)), name, contender: key };
}

/** A result of the contender whose case id is `id` (`<contest>/<key>`) that failed on Node in `phase`. */
function failedContender(
  id: string,
  phase: ChildPhase,
  message: string,
  teardownError: ResultError["teardownError"] = null,
): FailedResult {
  const slash = id.lastIndexOf("/");
  return {
    ...failed(id, phase, message, teardownError),
    name: id.slice(0, slash),
    contender: id.slice(slash + 1),
  };
}

/** Contender `id` of a contest entry, with its median, and its ratio and rank once judged (null otherwise). */
function contender(
  id: string,
  median: number | null,
  ratio: number | null = null,
  rank: number | null = null,
): ContestContender {
  return { id, median, ratio, rank };
}

/** The verdict of contenders `a` and `b` of contest `name`: the faster's key, or the kind of tie. */
function pair(
  name: string,
  [a, b]: readonly [string, string],
  [ratio, interval]: readonly [number, readonly [number, number]],
  verdict: { readonly faster: string } | { readonly tie: "rounds" | "timer" },
): ContestPair {
  return {
    a: `${name}/${a}`,
    b: `${name}/${b}`,
    ratio,
    interval,
    p: 0.01,
    pAdjusted: 0.01,
    faster: "faster" in verdict ? `${name}/${verdict.faster}` : null,
    tie: "tie" in verdict ? verdict.tie : null,
  };
}

/** The entry of contest `name` on Node over `rounds` rounds. */
function contest(
  name: string,
  rounds: number,
  contenders: readonly ContestContender[],
  pairs: readonly ContestPair[],
): Contest {
  return {
    name,
    params: {},
    runtime: runtimeOf("node"),
    rounds,
    contenders,
    pairs,
  };
}

/** `entry` as it would read on Bun. */
function onBun(entry: Contest): Contest {
  return { ...entry, runtime: runtimeOf("bun") };
}

/** The entry of contest `name` judged over `rounds` rounds, `fast` proven faster than `slow`. */
function judgedContest(
  name: string,
  rounds: number,
  [fast, slow]: readonly [string, string],
): Contest {
  return contest(
    name,
    rounds,
    [contender(`${name}/${fast}`, 100, 1, 1), contender(`${name}/${slow}`, 200, 2, 2)],
    [pair(name, [fast, slow], [2, [1.9, 2.1]], { faster: fast })],
  );
}

/** The results of the two contenders of `judgedContest(name, …, [fast, slow])`. */
function judgedResults(name: string, [fast, slow]: readonly [string, string]): MeasuredResult[] {
  return [contenderResult(name, fast, 100), contenderResult(name, slow, 200)];
}

/** A contest not judged over 9 rounds, one contender measured and one failed, with its results. */
function unfinishedContest(
  name: string,
  [finished, failedKey]: readonly [string, string],
  median: number,
): { results: Result[]; entry: Contest } {
  return {
    results: [
      contenderResult(name, finished, median),
      failedContender(`${name}/${failedKey}`, "fn", "kiwi"),
    ],
    entry: contest(
      name,
      9,
      [contender(`${name}/${finished}`, median), contender(`${name}/${failedKey}`, null)],
      [],
    ),
  };
}

/** A contest of two finished contenders not judged over `rounds` rounds, with its results. */
function notJudgedContest(rounds: number): { results: Result[]; entry: Contest } {
  return {
    results: [contenderResult("concat", "join", 806), contenderResult("concat", "loop", 1880)],
    entry: contest(
      "concat",
      rounds,
      [contender("concat/join", 806), contender("concat/loop", 1880)],
      [],
    ),
  };
}

/** The keys of the contenders of `threeWayContest`, fastest first. */
const THREE_WAY = ["regex", "split", "scan"] as const;

/** The results of the contenders of `threeWayContest(name, …)` measured on `runtime`. */
function threeWayResults(name: string, runtime: Runtime = "node"): MeasuredResult[] {
  return THREE_WAY.map((key, index) => contenderResult(name, key, 100 + index, runtime));
}

/** A contest `name` over `rounds` rounds among regex, split and scan, its regex–split and split–scan pairs tied by the given kinds, or proven for the first when null. */
function threeWayContest(
  name: string,
  rounds: number,
  [regexSplit, splitScan]: readonly [ContestPair["tie"], ContestPair["tie"]],
): Contest {
  return contest(
    name,
    rounds,
    [
      contender(`${name}/regex`, 100, 1, 1),
      contender(`${name}/split`, 101, 1.01, 1),
      contender(`${name}/scan`, 102, 1.02, 2),
    ],
    [
      pair(
        name,
        ["regex", "split"],
        [1.01, [0.98, 1.03]],
        regexSplit === null ? { faster: "regex" } : { tie: regexSplit },
      ),
      pair(
        name,
        ["split", "scan"],
        [1.01, [0.98, 1.03]],
        splitScan === null ? { faster: "split" } : { tie: splitScan },
      ),
      pair(name, ["regex", "scan"], [1.02, [1.01, 1.03]], { faster: "regex" }),
    ],
  );
}

/** A pattern for a note line of contest `name` naming every key of `named`, none of `unnamed` and no case id, with `--rounds rounds` advice, or none when null. */
function notePattern(
  name: string,
  named: readonly string[],
  unnamed: readonly string[],
  rounds: number | null,
): RegExp {
  const keys = [
    ...named.map((key) => `(?=.*\\b${key}\\b)`),
    ...unnamed.map((key) => `(?!.*\\b${key}\\b)`),
  ];
  const advice = rounds === null ? "(?!.*--rounds)" : `(?=.*--rounds ${rounds}\\b)`;
  return new RegExp(`^${keys.join("")}(?!.*${name}/)${advice}.*\\S`, "u");
}

/** The lines of the table of `results` and `contests`, the last one empty after the closing newline. */
function tableLines(
  results: readonly Result[],
  contests: readonly Contest[] = [],
  color = false,
): string[] {
  return formatTable(results, contests, { color }).split("\n");
}

/** The contender ids scheduled in a contest on `runtime`, as the table receives them. */
function contestedOn(
  runtime: Runtime,
  ids: readonly string[],
): readonly [Runtime, ReadonlySet<string>] {
  return [runtime, new Set(ids)];
}

/** The lines of the table of `results` with no finished contest, `contested` scheduled in a contest. */
function contestedTableLines(
  results: readonly Result[],
  contested: readonly (readonly [Runtime, ReadonlySet<string>])[],
): string[] {
  return formatTable(results, [], { color: false, contested: new Map(contested) }).split("\n");
}

/** The sentence the footer ends with when a plain case ran beside a contest not judged. */
function plainCaseLine(): string | undefined {
  const { results, entry } = notJudgedContest(3);
  return footerLines(
    tableLines([measured("apple", "node", flatStats(812)), ...results], [entry]),
  ).at(-1);
}

/** The footer of `lines`: its lines after the last blank line before the closing one. */
function footerLines(lines: readonly string[]): string[] {
  return lines.slice(lines.lastIndexOf("", -2) + 1, -1);
}

/** The footer of the table of `results` and `contests`: its lines after the last block, joined. */
function footer(results: readonly Result[], contests: readonly Contest[]): string {
  return footerLines(tableLines(results, contests)).join("\n");
}

/** The lines between the first row of `key` at or after line `from` and the next blank line. */
function notesUnder(lines: readonly string[], key: string, from = 0): string[] {
  const row = lines.findIndex((line, index) => index >= from && line.startsWith(`${key} `));
  if (row === -1) throw new Error(`no row of ${key} at or after line ${from}`);
  return lines.slice(row + 1, lines.indexOf("", row));
}

/** The index of the first line that starts with `id` and a space, or -1 when no row does. */
function rowIndex(lines: readonly string[], id: string): number {
  return lines.findIndex((line) => line.startsWith(`${id} `));
}

/** The terminal columns at which `line` draws a `│`, `┬` or `┼`. */
function barColumns(line: string): number[] {
  return [...line.matchAll(/[│┬┼]/gu)].map((bar) => visibleWidth(line.slice(0, bar.index)));
}

/** The trimmed cells of `line`, split on ` │ `. */
function cellsOf(line: string): string[] {
  return line.split(" │ ").map((cell) => cell.trim());
}

/** Whether the padded `cell` of column `column` has none on its flush side: the left of the first column, the right of the others. */
function isFlush(cell: string, column: number): boolean {
  return cell === (column === 0 ? cell.trimStart() : cell.trimEnd());
}

/** Asserts `box` (top rule, header, middle rule, measured rows) is aligned and each column as wide as its widest cell, `failedLabels` included. */
function expectBox(box: readonly string[], failedLabels: readonly string[] = []): void {
  const [top = "", header = "", middle = "", ...rows] = box;
  const lines = [header, ...rows];
  const cells = lines.map(cellsOf);
  const widest = cellsOf(header).map((_, column) =>
    Math.max(
      ...cells.map((row) => visibleWidth(row[column] ?? "")),
      ...(column === 0 ? failedLabels.map(visibleWidth) : []),
    ),
  );
  const flush = lines.every((line) => line.split(" │ ").every(isFlush));

  expect({
    rules: [/^[─┬]+$/u.test(top), /^[─┼]+$/u.test(middle)],
    widths: box.map(visibleWidth),
    bars: box.map(barColumns),
    columns: header.split(" │ ").map(visibleWidth),
    flush,
  }).toStrictEqual({
    rules: [true, true],
    widths: box.map(() => visibleWidth(top)),
    bars: box.map(() => barColumns(top)),
    columns: widest,
    flush: true,
  });
}

/** The index of the first line naming `runtime` and its version, or -1 when none does. */
function headingIndex(lines: readonly string[], runtime: Runtime): number {
  return lines.findIndex((line) => line.includes(runtime) && line.includes(found(runtime).version));
}

/** The indent under the message cell of the row at line `row`. */
function messageIndent(lines: readonly string[], row: number): string {
  return " ".repeat((lines[row]?.indexOf("│") ?? 0) + 2);
}

/** The trimmed cells of the row of case `id` in the table of `results`, split on ` │ `. */
function rowTexts(results: readonly Result[], id: string): string[] {
  const lines = tableLines(results);
  return cellsOf(lines[rowIndex(lines, id)] ?? "");
}

describe("formatTable", () => {
  describe("when there is no result", () => {
    it("returns the empty string", () => {
      const table = formatTable([], [], { color: false });

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

  describe("when a failed row holds a section's longest id", () => {
    it("boxes the section with every row padded to that id", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        measured("elderberry", "node", WIDE_STATS),
        failed("watermelons", "fn", "plum exploded"),
        failed("fig", "fn", "kiwi"),
      ];

      const lines = tableLines(results);

      expectBox(lines.slice(1, 6), ["watermelons", "fig"]);
      expect(lines.slice(4, 6).map(cellsOf)).toStrictEqual([
        ["apple", "812 ns", "812 ns", "812 ns", "812 ns", "64"],
        ["elderberry", "4.66 µs", "4.66 µs", "4.66 µs", "2.34 ms", "1200"],
      ]);
      expect(lines.slice(6)).toStrictEqual([
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
      expect(order).not.toContain(-1);
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
      const indent = messageIndent(lines, row);
      expect(lines.slice(row + 1, row + 3)).toStrictEqual([
        `${indent}at the stone`,
        `${indent}  and the pit`,
      ]);
    });

    describe("when its cleanup teardown failed too", () => {
      it("continues the row with a labelled line holding the teardown's message", () => {
        const teardownError = { message: "melon split", stack: "at teardown" };
        const results = [failed("apple", "fn", "plum exploded", teardownError)];

        const lines = tableLines(results);

        const row = rowIndex(lines, "apple");
        const indent = messageIndent(lines, row);
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

  describe("when a contest ran between plain cases", () => {
    it("lays the contest's sub-table out between the plain cases", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        contenderResult("concat", "loop", 81_200),
        contenderResult("concat", "join", 812),
        contenderResult("concat", "array-push", 941),
        measured("cherry", "node", flatStats(812)),
      ];
      const contests = [
        contest(
          "concat",
          8,
          [
            contender("concat/join", 812, 1, 1),
            contender("concat/array-push", 941, 1.16, 2),
            contender("concat/loop", 81_200, 100, 3),
          ],
          [
            pair("concat", ["join", "array-push"], [1.16, [1.12, 1.19]], { faster: "join" }),
            pair("concat", ["join", "loop"], [100, [98.1, 102]], { faster: "join" }),
            pair("concat", ["array-push", "loop"], [86.3, [84.2, 88.5]], { faster: "array-push" }),
          ],
        ),
      ];

      const lines = tableLines(results, contests);

      expectBox(lines.slice(1, 5));
      expectBox(lines.slice(7, 13));
      expectBox(lines.slice(14, 18));
      expect([lines[0], lines[5], lines[13], lines[18]]).toStrictEqual(["node 24.1.0", "", "", ""]);
      expect(lines[6]).toMatch(/^concat\b.*\b8 rounds$/u);
      const rows = [lines[4], ...lines.slice(10, 13), lines[17]];
      expect(rows.map((row) => cellsOf(row ?? ""))).toStrictEqual([
        ["apple", "812 ns", "812 ns", "812 ns", "812 ns", "64"],
        ["join", "812 ns", "1.00×", "1"],
        ["array-push", "941 ns", "1.16×", "2"],
        ["loop", "81.2 µs", "100.00×", "3"],
        ["cherry", "812 ns", "812 ns", "812 ns", "812 ns", "64"],
      ]);
    });
  });

  describe("when a contender was selected alone", () => {
    it("rows it as a plain case under its case id", () => {
      const results = [contenderResult("concat", "join", 812)];

      const row = rowTexts(results, "concat/join");

      expect(row).toStrictEqual(["concat/join", "812 ns", "812 ns", "812 ns", "812 ns", "64"]);
    });

    describe("when the same benchmark was a contest on another runtime", () => {
      it("rows it as a plain case under its case id", () => {
        const results = [contenderResult("concat", "join", 812)];

        const lines = contestedTableLines(results, [
          contestedOn("node", ["parse/regex", "parse/split"]),
          contestedOn("bun", ["concat/join", "concat/loop"]),
        ]);

        expect(cellsOf(lines[rowIndex(lines, "concat/join")] ?? "")).toStrictEqual([
          "concat/join",
          "812 ns",
          "812 ns",
          "812 ns",
          "812 ns",
          "64",
        ]);
      });
    });
  });

  describe("when the stop signal ended a contest after a contender failed", () => {
    const stoppedContest = [contestedOn("node", ["concat/join", "concat/loop"])];

    it("rows the failed contender by its key in the contest's block", () => {
      const results = [failedContender("concat/loop", "fn", "kiwi")];

      const lines = contestedTableLines(results, stoppedContest);

      const loop = rowIndex(lines, "loop");
      const heading = lines.findIndex((line) => /^concat(?:\s|$)/u.test(line));
      expect(rowIndex(lines, "concat/loop")).toBe(-1);
      expect(lines[loop]).toMatch(/^loop {6}│ \S.* kiwi$/u);
      expect(heading).not.toBe(-1);
      expect(heading).toBeLessThan(loop);
    });

    it("does not end with the footer of a run of plain cases alone", () => {
      const plainRun = footer([measured("apple", "node", flatStats(812))], []);
      const results = [failedContender("concat/loop", "fn", "kiwi")];

      const footerOf = footerLines(contestedTableLines(results, stoppedContest));

      expect(plainRun).toMatch(/\S/u);
      expect(footerOf).not.toContain(plainRun);
    });

    it.each([
      { ran: "only the contest's contender ran", plain: [], says: false },
      {
        ran: "a plain case ran too",
        plain: [measured("apple", "node", flatStats(812))],
        says: true,
      },
    ])("adds the plain-case line to the footer only when $ran", ({ plain, says }) => {
      const sentence = plainCaseLine();
      const results = [...plain, failedContender("concat/loop", "fn", "kiwi")];

      const footerOf = footerLines(contestedTableLines(results, stoppedContest));

      expect(sentence).toMatch(/\S/u);
      expect(footerOf.includes(sentence ?? "")).toBe(says);
    });
  });

  describe("when a contest ran on several runtimes", () => {
    it("opens each runtime's sub-table with that runtime's rounds", () => {
      const results = [
        ...judgedResults("concat", ["join", "loop"]),
        contenderResult("concat", "join", 100, "bun"),
        contenderResult("concat", "loop", 200, "bun"),
      ];
      const contests = [
        judgedContest("concat", 8, ["join", "loop"]),
        onBun(judgedContest("concat", 9, ["join", "loop"])),
      ];

      const lines = tableLines(results, contests);

      const nineRounds = lines.findIndex((line) => /^concat\b.*\b9 rounds$/u.test(line));
      expect(nineRounds).toBeGreaterThan(headingIndex(lines, "bun"));
    });
  });

  describe("when a contest was not judged", () => {
    it("shows only contenders and medians", () => {
      const { results, entry } = notJudgedContest(3);

      const lines = tableLines(results, [entry]);

      expectBox(lines.slice(3, 8));
      expect(lines.slice(0, 2)).toStrictEqual(["node 24.1.0", ""]);
      expect(lines.slice(6, 8).map(cellsOf)).toStrictEqual([
        ["join", "806 ns"],
        ["loop", "1.88 µs"],
      ]);
    });

    it.each([
      { rounds: 1, text: "1 round" },
      { rounds: 3, text: "3 rounds" },
    ])("heads the contest and closes it with not judged over $text", ({ rounds, text }) => {
      const { results, entry } = notJudgedContest(rounds);

      const lines = tableLines(results, [entry]);

      expect(lines[2]).toMatch(new RegExp(`^concat\\b.*\\b${text}$`, "u"));
      expect(lines[8]).toMatch(new RegExp(`\\b${text}$`, "u"));
    });

    it("rows a failed contender before the not judged line", () => {
      const results = [
        failedContender("concat/plus", "fn", "kiwi"),
        contenderResult("concat", "join", 806),
        contenderResult("concat", "loop", 1880),
      ];
      const contests = [
        contest(
          "concat",
          1,
          [
            contender("concat/join", 806),
            contender("concat/loop", 1880),
            contender("concat/plus", null),
          ],
          [],
        ),
      ];

      const lines = tableLines(results, contests);

      const loop = rowIndex(lines, "loop");
      expectBox(lines.slice(loop - 4, loop + 1), ["plus"]);
      expect(cellsOf(lines[loop] ?? "")).toStrictEqual(["loop", "1.88 µs"]);
      expect(lines.slice(loop + 1, loop + 3)).toStrictEqual([
        expect.stringMatching(/^plus {6}│ \S.* kiwi$/u),
        expect.stringMatching(/\b1 round$/u),
      ]);
    });

    describe("when fewer than two of its contenders finished", () => {
      it("ends the sub-table with a not judged line that holds no round count", () => {
        const { results, entry } = unfinishedContest("concat", ["join", "loop"], 806);

        const lines = tableLines(results, [entry]);

        const loop = rowIndex(lines, "loop");
        expect(loop).not.toBe(-1);
        const notJudged = lines[loop + 1];
        expect(notJudged).toMatch(/\S/u);
        expect(notJudged).not.toMatch(/\bround/u);
      });
    });
  });

  describe("when a contest ran", () => {
    describe("when no contest was judged", () => {
      describe("when no contest had two finished contenders", () => {
        it("does not blame the rounds in the footer", () => {
          const { results, entry } = unfinishedContest("concat", ["join", "loop"], 806);

          const text = footer(results, [entry]);

          expect(text).toMatch(/\S/u);
          expect(text).not.toMatch(/\bround/u);
        });
      });

      describe("when one contest had two finished contenders and another did not", () => {
        it("blames the rounds in the footer as when every contest had them", () => {
          const unfinished = unfinishedContest("parse", ["regex", "split"], 100);
          const finished = notJudgedContest(9);
          const roundsFooter = footer(finished.results, [finished.entry]);

          const text = footer(
            [...unfinished.results, ...finished.results],
            [unfinished.entry, finished.entry],
          );

          expect(roundsFooter).toMatch(/\bround/u);
          expect(text).toBe(roundsFooter);
        });
      });

      describe("when a plain case ran", () => {
        it("adds one line to the footer of the same run without the plain case", () => {
          const { results: contestResults, entry } = notJudgedContest(3);
          const contestFooter = footerLines(tableLines(contestResults, [entry]));

          const withPlain = footerLines(
            tableLines([measured("apple", "node", flatStats(812)), ...contestResults], [entry]),
          );

          expect(withPlain).toStrictEqual([...contestFooter, expect.stringMatching(/\S/u)]);
        });
      });
    });

    describe("when every contest was judged with no tie", () => {
      it("ends after the last table when no plain case ran", () => {
        const results = [
          ...judgedResults("concat", ["join", "loop"]),
          ...judgedResults("parse", ["regex", "split"]),
        ];
        const contests = [
          judgedContest("concat", 7, ["join", "loop"]),
          judgedContest("parse", 8, ["regex", "split"]),
        ];

        const lines = tableLines(results, contests);

        expect(lines.slice(-2)).toStrictEqual([expect.stringMatching(/^split /u), ""]);
      });

      it("ends with the plain-case sentence alone when a plain case ran", () => {
        const apple = measured("apple", "node", flatStats(812));
        const notJudged = tableLines(
          [apple, contenderResult("sort", "quick", 100), contenderResult("sort", "merge", 200)],
          [contest("sort", 3, [contender("sort/quick", 100), contender("sort/merge", 200)], [])],
        );
        const plainSentence = footerLines(notJudged).at(-1);

        const lines = tableLines(
          [apple, ...judgedResults("concat", ["join", "loop"])],
          [judgedContest("concat", 7, ["join", "loop"])],
        );

        expect(plainSentence).toMatch(/\S/u);
        expect(lines.slice(rowIndex(lines, "loop") + 1)).toStrictEqual(["", plainSentence, ""]);
      });
    });

    describe("when a judged contest had pairs the rounds did not settle", () => {
      it("names them by contender key under its table, recommending twice its rounds", () => {
        const results = [...judgedResults("concat", ["join", "loop"]), ...threeWayResults("parse")];
        const contests = [
          judgedContest("concat", 7, ["join", "loop"]),
          threeWayContest("parse", 9, ["rounds", "rounds"]),
        ];

        const lines = tableLines(results, contests);

        expect(notesUnder(lines, "loop")).toStrictEqual([]);
        expect(notesUnder(lines, "scan")).toStrictEqual([
          expect.stringMatching(notePattern("parse", ["regex", "split", "scan"], [], 18)),
        ]);
      });
    });

    describe("when a judged contest had pairs within the timer's resolution", () => {
      it("names them by contender key under its table with no rounds advice", () => {
        const results = threeWayResults("parse");

        const lines = tableLines(results, [threeWayContest("parse", 9, [null, "timer"])]);

        expect(notesUnder(lines, "scan")).toStrictEqual([
          expect.stringMatching(notePattern("parse", ["split", "scan"], ["regex"], null)),
        ]);
      });
    });

    describe("when a judged contest had both kinds of tie", () => {
      it("prints a line for each kind under its table, each naming only its own pairs", () => {
        const results = threeWayResults("parse");

        const lines = tableLines(results, [threeWayContest("parse", 9, ["rounds", "timer"])]);

        const notes = notesUnder(lines, "scan");
        expect(notes).toHaveLength(2);
        expect(notes).toStrictEqual(
          expect.arrayContaining([
            expect.stringMatching(notePattern("parse", ["regex", "split"], ["scan"], 18)),
            expect.stringMatching(notePattern("parse", ["split", "scan"], ["regex"], null)),
          ]),
        );
      });
    });
  });

  describe("when colored", () => {
    const notJudged = notJudgedContest(3);
    const apple = measured("apple", "node", flatStats(812));

    it.each([
      {
        lines: "each tie line",
        results: threeWayResults("parse"),
        contests: [threeWayContest("parse", 9, ["rounds", "timer"])],
        select: (lines: readonly string[]) => notesUnder(lines, "scan"),
      },
      {
        lines: "the not judged line",
        results: notJudged.results,
        contests: [notJudged.entry],
        select: (lines: readonly string[]) => notesUnder(lines, "loop"),
      },
      {
        lines: "the footer when no contest was judged and a plain case ran",
        results: [apple, ...notJudged.results],
        contests: [notJudged.entry],
        select: footerLines,
      },
    ])("styles $lines, printed with no escape codes when not colored", (scenario) => {
      const plain = tableLines(scenario.results, scenario.contests);

      const colored = tableLines(scenario.results, scenario.contests, true);

      const selected = scenario.select(colored);
      const plainSelected = scenario.select(plain);
      expect(selected.length).toBeGreaterThan(0);
      expect(colored.map((line) => stripVTControlCharacters(line))).toStrictEqual(plain);
      expect(selected.filter((line, index) => line === plainSelected[index])).toStrictEqual([]);
    });
  });
});

describe("visibleWidth", () => {
  it.each([
    { text: "梨", label: "a Han character", width: 2 },
    { text: "rose\u0301", label: "a combining mark", width: 4 },
    { text: paint("red", "fig", true), label: "escape codes", width: 3 },
  ])("counts the terminal columns of text with $label", ({ text, width }) => {
    const columns = visibleWidth(text);

    expect(columns).toBe(width);
  });
});

describe("failureLines", () => {
  describe("when the lead is colored", () => {
    it("continues a further line of the message as wide as the visible lead", () => {
      const plainLead = "failed x: ";
      const lead = `${paint("red", "failed", true)} x: `;

      const lines = failureLines(lead, { message: "kiwi\nplum", teardownError: null }, "  ");

      expect(lines).toStrictEqual([`${lead}kiwi`, `${" ".repeat(plainLead.length)}plum`]);
    });
  });
});
