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
import { formatTable } from "../src/table.js";
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

/** The verdict of contenders `a` and `b` of contest `name`, `faster` the faster's key or null for a tie. */
function pair(
  name: string,
  [a, b]: readonly [string, string],
  [ratio, interval]: readonly [number, readonly [number, number]],
  faster: string | null,
): ContestPair {
  return {
    a: `${name}/${a}`,
    b: `${name}/${b}`,
    ratio,
    interval,
    p: 0.01,
    pAdjusted: 0.01,
    faster: faster === null ? null : `${name}/${faster}`,
    tie: faster === null ? "rounds" : null,
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
    runtime: { name: "node", version: found("node").version },
    rounds,
    contenders,
    pairs,
  };
}

/** `entry` as it would read on Bun. */
function onBun(entry: Contest): Contest {
  return { ...entry, runtime: { name: "bun", version: found("bun").version } };
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
    [pair(name, [fast, slow], [2, [1.9, 2.1]], fast)],
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

/** The lines of the table of `results` and `contests`, the last one empty after the closing newline. */
function tableLines(results: readonly Result[], contests: readonly Contest[] = []): string[] {
  return formatTable(results, contests, { color: false }).split("\n");
}

/** The footer of the table of `results` and `contests`: its lines after the last block, joined. */
function footer(results: readonly Result[], contests: readonly Contest[]): string {
  const lines = tableLines(results, contests);
  return lines.slice(lines.lastIndexOf("", -2) + 1, -1).join("\n");
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

  describe("when an id holds wide characters or combining marks", () => {
    it("pads every row to the columns the ids take on a terminal", () => {
      const results = [
        measured("苹果苹果", "node", flatStats(812)),
        measured("rose\u0301", "node", flatStats(812)),
        failed("梨", "fn", "kiwi"),
      ];

      const lines = tableLines(results);

      expect(lines.slice(1, 7)).toStrictEqual([
        rule("┬", [9, 8, 8, 8, 8, 8]),
        "case     │ median │   mean │    min │    max │ samples",
        rule("┼", [9, 8, 8, 8, 8, 8]),
        "苹果苹果 │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
        "rose\u0301     │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
        expect.stringMatching(/^梨 {7}│ \S.* kiwi$/u),
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
      const indent = " ".repeat((lines[row]?.indexOf("│") ?? 0) + 2);
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

  describe("when a contest ran between plain cases", () => {
    it("lays the contest's sub-table out between the plain cases", () => {
      const results = [
        measured("apple", "node", flatStats(812)),
        contenderResult("concat", "loop", 1900),
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
            contender("concat/loop", 1900, 2.31, 3),
          ],
          [
            pair("concat", ["join", "array-push"], [1.16, [1.12, 1.19]], "join"),
            pair("concat", ["join", "loop"], [2.31, [2.18, 2.47]], "join"),
            pair("concat", ["array-push", "loop"], [1.99, [1.9, 2.1]], "array-push"),
          ],
        ),
      ];

      const lines = tableLines(results, contests);

      expect(lines.slice(0, 19)).toStrictEqual([
        "node 24.1.0",
        rule("┬", [6, 8, 8, 8, 8, 8]),
        "case  │ median │   mean │    min │    max │ samples",
        rule("┼", [6, 8, 8, 8, 8, 8]),
        "apple │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
        "",
        "concat · 8 rounds",
        rule("┬", [11, 9, 19, 5]),
        "contender  │  median │ ratio             │ rank",
        rule("┼", [11, 9, 19, 5]),
        "join       │  812 ns │ 1.00×             │    1",
        "array-push │  941 ns │ 1.16× (1.12–1.19) │    2",
        "loop       │ 1.90 µs │ 2.31× (2.18–2.47) │    3",
        "",
        rule("┬", [7, 8, 8, 8, 8, 8]),
        "case   │ median │   mean │    min │    max │ samples",
        rule("┼", [7, 8, 8, 8, 8, 8]),
        "cherry │ 812 ns │ 812 ns │ 812 ns │ 812 ns │      64",
        "",
      ]);
    });
  });

  describe("when a contender was selected alone", () => {
    it("rows it as a plain case under its case id", () => {
      const results = [contenderResult("concat", "join", 812)];

      const row = rowTexts(results, "concat/join");

      expect(row).toStrictEqual(["concat/join", "812 ns", "812 ns", "812 ns", "812 ns", "64"]);
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

      expect(lines.indexOf("concat · 9 rounds")).toBeGreaterThan(headingIndex(lines, "bun"));
    });
  });

  describe("when a contest was not judged", () => {
    it.each([
      { rounds: 1, text: "1 round" },
      { rounds: 3, text: "3 rounds" },
    ])("shows only contenders and medians, then not judged over $text", ({ rounds, text }) => {
      const results = [
        contenderResult("concat", "join", 806),
        contenderResult("concat", "loop", 1880),
      ];
      const contests = [
        contest(
          "concat",
          rounds,
          [contender("concat/join", 806), contender("concat/loop", 1880)],
          [],
        ),
      ];

      const lines = tableLines(results, contests);

      expect(lines.slice(0, 9)).toStrictEqual([
        "node 24.1.0",
        "",
        `concat · ${text}`,
        rule("┬", [10, 8]),
        "contender │  median",
        rule("┼", [10, 8]),
        "join      │  806 ns",
        "loop      │ 1.88 µs",
        expect.stringMatching(new RegExp(`\\b${text}$`, "u")),
      ]);
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
      expect(lines.slice(loop, loop + 3)).toStrictEqual([
        "loop      │ 1.88 µs",
        expect.stringMatching(/^plus {6}│ \S.* kiwi$/u),
        expect.stringMatching(/\b1 round$/u),
      ]);
    });

    describe("when fewer than two of its contenders finished", () => {
      it("ends the sub-table with a not judged line that holds no round count", () => {
        const { results, entry } = unfinishedContest("concat", ["join", "loop"], 806);

        const lines = tableLines(results, [entry]);

        const notJudged = lines[rowIndex(lines, "loop") + 1];
        expect(notJudged).toMatch(/\S/u);
        expect(notJudged).not.toMatch(/\bround/u);
      });
    });
  });

  describe("when a contest ran", () => {
    describe("when no contest was judged", () => {
      it("counts no contest and no rounds in the footer", () => {
        const results = [
          contenderResult("concat", "join", 806),
          contenderResult("concat", "loop", 1880),
        ];
        const contests = [
          contest("concat", 1, [contender("concat/join", 806), contender("concat/loop", 1880)], []),
        ];

        const text = footer(results, contests);

        expect(text).not.toMatch(/\d/u);
      });

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
          const finishedResults = [
            contenderResult("concat", "join", 806),
            contenderResult("concat", "loop", 1880),
          ];
          const finishedContest = contest(
            "concat",
            9,
            [contender("concat/join", 806), contender("concat/loop", 1880)],
            [],
          );
          const roundsFooter = footer(finishedResults, [finishedContest]);

          const text = footer(
            [...unfinished.results, ...finishedResults],
            [unfinished.entry, finishedContest],
          );

          expect(roundsFooter).toMatch(/\bround/u);
          expect(text).toBe(roundsFooter);
        });
      });
    });

    describe("when another contest was not judged", () => {
      it("counts only the judged contests in the footer", () => {
        const results = [
          ...judgedResults("concat", ["join", "loop"]),
          ...judgedResults("parse", ["regex", "split"]),
          contenderResult("sort", "quick", 100),
          contenderResult("sort", "merge", 200),
        ];
        const contests = [
          judgedContest("concat", 9, ["join", "loop"]),
          judgedContest("parse", 9, ["regex", "split"]),
          contest("sort", 9, [contender("sort/quick", 100), contender("sort/merge", 200)], []),
        ];

        const text = footer(results, contests);

        expect(text).toMatch(/\b2\b/u);
        expect(text).not.toMatch(/\b3\b/u);
      });
    });

    describe("when the judged contests ran one round count and a contest not judged ran another", () => {
      it("states the judged contests' round count alone in the footer", () => {
        const results = [
          ...judgedResults("concat", ["join", "loop"]),
          ...judgedResults("parse", ["regex", "split"]),
          contenderResult("sort", "quick", 100),
          contenderResult("sort", "merge", 200),
        ];
        const contests = [
          judgedContest("concat", 9, ["join", "loop"]),
          judgedContest("parse", 9, ["regex", "split"]),
          contest("sort", 4, [contender("sort/quick", 100), contender("sort/merge", 200)], []),
        ];

        const text = footer(results, contests);

        expect(text.match(/[\d–]+ rounds?\b/gu)).toStrictEqual(["9 rounds"]);
      });
    });

    describe("when contests ran different round counts", () => {
      it("states each round count in the footer", () => {
        const results = [
          ...judgedResults("concat", ["join", "loop"]),
          ...judgedResults("parse", ["regex", "split"]),
        ];
        const contests = [
          judgedContest("concat", 7, ["join", "loop"]),
          judgedContest("parse", 8, ["regex", "split"]),
        ];

        const text = footer(results, contests);

        expect(text).toMatch(/\b7\b/u);
        expect(text).toMatch(/\b8\b/u);
      });
    });

    describe("when a contest was tied", () => {
      it("recommends twice its rounds in the footer", () => {
        const results = [
          ...judgedResults("concat", ["join", "loop"]),
          ...judgedResults("parse", ["regex", "split"]),
        ];
        const contests = [
          judgedContest("concat", 7, ["join", "loop"]),
          contest(
            "parse",
            9,
            [contender("parse/regex", 100, 1, 1), contender("parse/split", 101, 1.01, 1)],
            [pair("parse", ["regex", "split"], [1.01, [0.98, 1.03]], null)],
          ),
        ];

        const text = footer(results, contests);

        expect(text).toMatch(/\b18\b/u);
        expect(text).not.toMatch(/\b14\b/u);
      });
    });

    describe("when a plain case ran too", () => {
      it("adds the plain-case sentence to the footer", () => {
        const contestResults = judgedResults("concat", ["join", "loop"]);
        const contests = [judgedContest("concat", 7, ["join", "loop"])];
        const contestFooter = footer(contestResults, contests);

        const withPlain = footer(
          [measured("apple", "node", flatStats(812)), ...contestResults],
          contests,
        );

        const added = withPlain.slice(contestFooter.length).trim();
        expect({
          extendsContestFooter: withPlain.startsWith(contestFooter),
          addsText: added.length > 0,
          contestFooterHasIt: contestFooter.includes(added),
        }).toStrictEqual({ extendsContestFooter: true, addsText: true, contestFooterHasIt: false });
      });
    });
  });

  describe("when colored", () => {
    const results = [measured("elderberry", "node", WIDE_STATS)];

    it("styles the table", () => {
      const plain = formatTable(results, [], { color: false });

      const colored = formatTable(results, [], { color: true });

      expect(colored).not.toBe(plain);
    });
  });
});
