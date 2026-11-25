import { describe, expect, it } from "vitest";

import {
  levelCuts,
  pairedInterval,
  parseArguments,
  parseRun,
  report,
  twoProportionP,
} from "../../../scripts/diagnose-bun-gap/analyze.js";
import type { Header, Reading, Run } from "../../../scripts/diagnose-bun-gap/analyze.js";
import { errorOf } from "../../helpers/error-of.js";
import { wordsInOrder } from "../../helpers/words-in-order.js";

const FILE = "runs/a.jsonl";
const GAP = 15;

/** A header for a pinned Azure run, with `overrides` applied. */
function header(overrides: Partial<Header> = {}): Header {
  return {
    kind: "header",
    cpuModel: "Intel Xeon",
    cpuCount: 4,
    kernel: "6.8.0",
    sysVendor: "Microsoft Corporation",
    productName: "Virtual Machine",
    bunVersion: "1.3.0",
    nodeVersion: "26.1.0",
    commit: "abc123",
    runId: "7",
    runAttempt: "1",
    pinned: true,
    cyclesPerBody: 4,
    sides: ["repset", "baseline", "none"],
    sampleCounts: { each: 64, inlined: 64 },
    ...overrides,
  };
}

/** A reading of the `each` body on the repset side, with `overrides` applied. */
function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    kind: "reading",
    cycle: 0,
    position: 0,
    body: "each",
    side: "repset",
    median: 100,
    sampleCount: 64,
    firstHalfMedian: 100,
    secondHalfMedian: 100,
    p75: 101,
    p99: 110,
    cpuStart: 0,
    cpuEnd: 0,
    pinnedCpu: 0,
    time: "2026-11-25T10:00:00.000Z",
    ...overrides,
  };
}

/** One reading per cycle for each side, cycle `i` taking `medians[side][i]`. */
function cycles(
  medians: Readonly<Record<string, readonly number[]>>,
  body: Reading["body"] = "each",
): Reading[] {
  return Object.entries(medians).flatMap(([side, values], position) =>
    values.map((median, cycle) => reading({ cycle, position, body, side, median })),
  );
}

/** A run read from `file`, labelled `cloud`, holding `readings`. */
function run(
  readings: readonly Reading[],
  options: { file?: string; cloud?: string; header?: Partial<Header> } = {},
): Run {
  return {
    file: options.file ?? FILE,
    cloud: options.cloud ?? "azure",
    header: header(options.header),
    readings,
  };
}

/** The labels of the report's indented `<a> <separator> <b>:` lines, in order. */
function labels(text: string, separator: string): string[] {
  const pattern = new RegExp(String.raw`^ {2}(\S+ ${separator} \S+):`, "u");
  return text.split("\n").flatMap((line) => {
    const match = pattern.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/** Serializes `records` as JSON Lines, each line finished by a newline. */
function jsonLines(...records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

describe("pairedInterval", () => {
  it("returns the mean and the 95 % interval from the sample standard deviation", () => {
    const interval = pairedInterval([1, 2, 3, 4]);

    expect(interval).toStrictEqual({
      n: 4,
      mean: 2.5,
      low: expect.closeTo(1.234_825, 5),
      high: expect.closeTo(3.765_175, 5),
    });
  });
});

describe("levelCuts", () => {
  it("cuts midway between sorted neighbors that differ by more than the gap", () => {
    const cuts = levelCuts([131, 100, 200, 105, 130], GAP);

    expect(cuts).toStrictEqual([117.5, 165.5]);
  });

  it("does not cut between neighbors that differ by exactly the gap", () => {
    const cuts = levelCuts([115, 100], GAP);

    expect(cuts).toStrictEqual([]);
  });
});

describe("twoProportionP", () => {
  it("returns the two-sided p-value of the pooled z-test", () => {
    const p = twoProportionP(10, 20, 4, 20);

    expect(p).toBeCloseTo(0.046_703, 5);
  });

  it.each([
    { case: "both shares are 0", offA: 0, offB: 0 },
    { case: "both shares are 1", offA: 10, offB: 10 },
  ])("returns 1 when $case", ({ offA, offB }) => {
    const p = twoProportionP(offA, 10, offB, 10);

    expect(p).toBe(1);
  });
});

describe("parseArguments", () => {
  it("reads the level gap and each file with its cloud label", () => {
    const parsed = parseArguments(["--level-gap", "20", "a.jsonl=azure", "b.jsonl=aws"]);

    expect(parsed).toStrictEqual({
      levelGap: 20,
      inputs: [
        { file: "a.jsonl", cloud: "azure" },
        { file: "b.jsonl", cloud: "aws" },
      ],
    });
  });

  it("defaults the level gap to 15 ns", () => {
    const parsed = parseArguments(["a.jsonl=azure"]);

    expect(parsed.levelGap).toBe(15);
  });

  it("throws when no file is given", () => {
    const act = (): unknown => parseArguments(["--level-gap", "20"]);

    expect(act).toThrow(Error);
  });

  it.each([
    { case: "no =", argument: "a.jsonl" },
    { case: "an empty file", argument: "=azure" },
    { case: "an empty cloud label", argument: "a.jsonl=" },
  ])("throws naming an argument with $case", ({ argument }) => {
    const error = errorOf(() => parseArguments(["b.jsonl=aws", argument]));

    expect(error.message).toContain(argument);
  });

  it("throws naming a level gap that is not a positive number", () => {
    const error = errorOf(() => parseArguments(["--level-gap", "fast", "a.jsonl=azure"]));

    expect(error.message).toContain("fast");
  });
});

describe("parseRun", () => {
  describe("when every line is well formed", () => {
    it("returns the header and readings labelled with the file and cloud", () => {
      const text = jsonLines(header(), reading({ cycle: 0 }), reading({ cycle: 1 }));

      const parsed = parseRun(FILE, "azure", text);

      expect(parsed).toStrictEqual(run([reading({ cycle: 0 }), reading({ cycle: 1 })]));
    });

    it("keeps a complete last line that lacks its newline", () => {
      const text = jsonLines(header()) + JSON.stringify(reading());

      const parsed = parseRun(FILE, "azure", text);

      expect(parsed.readings).toStrictEqual([reading()]);
    });
  });

  describe("when the run stopped part way through a line", () => {
    it("drops the unfinished last line", () => {
      const text = jsonLines(header(), reading()) + JSON.stringify(reading()).slice(0, 30);

      const parsed = parseRun(FILE, "azure", text);

      expect(parsed.readings).toStrictEqual([reading()]);
    });
  });

  describe("when a line is malformed", () => {
    it.each([
      { case: "invalid JSON", lines: [header(), "{banana"], line: 2 },
      { case: "an unknown kind", lines: [header(), { kind: "banana" }], line: 2 },
      {
        case: "a reading field of the wrong type",
        lines: [header(), reading(), { ...reading(), median: "fast" }],
        line: 3,
      },
      { case: "an unknown body", lines: [header(), { ...reading(), body: "loop" }], line: 2 },
      {
        case: "a header field of the wrong type",
        lines: [{ ...header(), cpuCount: "4" }],
        line: 1,
      },
    ])("throws naming the file and line for $case", ({ lines, line }) => {
      const text = lines
        .map((entry) => `${typeof entry === "string" ? entry : JSON.stringify(entry)}\n`)
        .join("");

      const error = errorOf(() => parseRun(FILE, "azure", text));

      expect(error.message).toMatch(wordsInOrder(FILE, line));
    });
  });

  describe("when a header follows the first line", () => {
    it("throws naming the file and the second header's line", () => {
      const text = jsonLines(header(), reading(), header());

      const error = errorOf(() => parseRun(FILE, "azure", text));

      expect(error.message).toMatch(wordsInOrder(FILE, 3));
    });
  });

  describe("when the first line is not a header", () => {
    it.each([
      { case: "a reading", text: jsonLines(reading(), header()) },
      { case: "an empty file", text: "" },
    ])("throws naming the file for $case", ({ text }) => {
      const error = errorOf(() => parseRun(FILE, "azure", text));

      expect(error.message).toContain(FILE);
    });
  });
});

describe("report", () => {
  describe("when a cloud label is checked against the machine vendor", () => {
    it.each([
      { cloud: "azure", sysVendor: "Amazon EC2" },
      { cloud: "aws", sysVendor: "Microsoft Corporation" },
      { cloud: "local", sysVendor: "Microsoft Corporation" },
      { cloud: "azure", sysVendor: "Dell" },
    ])("warns when $cloud runs on $sysVendor", ({ cloud, sysVendor }) => {
      const text = report([run(cycles({ repset: [100] }), { cloud, header: { sysVendor } })], GAP);

      expect(text).toMatch(wordsInOrder("warning", FILE, cloud, sysVendor));
    });

    it.each([
      { cloud: "azure", sysVendor: "Microsoft Corporation" },
      { cloud: "aws", sysVendor: "Amazon EC2" },
      { cloud: "local", sysVendor: "Dell Inc." },
      { cloud: "azure", sysVendor: null },
    ])("does not warn when $cloud runs on $sysVendor", ({ cloud, sysVendor }) => {
      const text = report([run(cycles({ repset: [100] }), { cloud, header: { sysVendor } })], GAP);

      expect(text).not.toMatch(/warning/u);
    });
  });

  describe("when grouping records", () => {
    it("starts a section per attempt and per pinning and body within it", () => {
      const pair = { repset: [100], baseline: [100] };
      const runs = [
        run([...cycles(pair), ...cycles(pair, "inlined")], { file: "runs/a.jsonl" }),
        run(cycles(pair), { file: "runs/b.jsonl", header: { pinned: false } }),
        run(cycles(pair), { file: "runs/c.jsonl", header: { runAttempt: "2" } }),
        run(cycles(pair), { file: "runs/d.jsonl", header: { runId: null, runAttempt: null } }),
      ];

      const text = report(runs, GAP);

      expect(text.split("\n").filter((line) => /^(==|--) /u.test(line))).toStrictEqual([
        "== attempt 7/1: azure, Intel Xeon ==",
        "-- pinned, each --",
        "-- pinned, inlined --",
        "-- unpinned, each --",
        "== attempt 7/2: azure, Intel Xeon ==",
        "-- pinned, each --",
        "== attempt runs/d.jsonl: azure, Intel Xeon ==",
        "-- pinned, each --",
        "== roll-up ==",
      ]);
    });

    it("attaches every distinct cloud label of an attempt's files to it", () => {
      const runs = [
        run(cycles({ repset: [100] }), { file: "runs/a.jsonl", cloud: "azure" }),
        run(cycles({ repset: [100] }), { file: "runs/b.jsonl", cloud: "aws" }),
      ];

      const text = report(runs, GAP);

      expect(text).toContain("== attempt 7/1: azure+aws, Intel Xeon ==");
    });
  });

  describe("when pairing readings by cycle", () => {
    it("differences only the cycles both sides read, whatever their order", () => {
      const readings = [
        ...cycles({ repset: [101, 102, 103] }),
        reading({ side: "baseline", cycle: 2, median: 100 }),
        reading({ side: "baseline", cycle: 1, median: 100 }),
        reading({ side: "baseline", cycle: 3, median: 100 }),
      ];

      const text = report([run(readings)], GAP);

      expect(text).toContain("  repset - baseline: n=2 mean=2.50 95% [1.52, 3.48] equivalent: no");
    });

    it("never pairs readings of two files in the same attempt", () => {
      const runs = [
        run(cycles({ repset: [101, 102] }), { file: "runs/a.jsonl" }),
        run(cycles({ baseline: [100, 100] }), { file: "runs/b.jsonl" }),
      ];

      const text = report(runs, GAP);

      expect(text).toContain("  repset - baseline: n=0 ");
    });

    it("lists each side against none, repset against each side, then the none - baseline control", () => {
      const readings = cycles({ repset: [100], baseline: [100], none: [100], spin: [100] });

      const text = report([run(readings)], GAP);

      expect(labels(text, "-")).toStrictEqual([
        "repset - none",
        "baseline - none",
        "spin - none",
        "repset - baseline",
        "repset - spin",
        "none - baseline",
      ]);
    });

    it.each([
      { case: "inside ±1 ns around zero", repset: [100.1, 99.9, 100.2, 99.8], equivalent: "yes" },
      { case: "inside ±1 ns but off zero", repset: [100.5, 100.6, 100.5, 100.6], equivalent: "no" },
      { case: "around zero but wider than ±1 ns", repset: [103, 97, 102, 98], equivalent: "no" },
    ])("marks repset equivalent $equivalent with an interval $case", ({ repset, equivalent }) => {
      const readings = cycles({
        repset,
        baseline: [100, 100, 100, 100],
        none: [100, 100, 100, 100],
      });

      const text = report([run(readings)], GAP);

      expect(text).toMatch(wordsInOrder("repset - baseline", `equivalent: ${equivalent}`));
    });

    it.each([
      { case: "a wide interval around zero", none: [101, 99, 102, 98], verdict: "control pass" },
      { case: "an interval off zero", none: [103, 103, 104, 104], verdict: "control FAIL" },
    ])("reports $verdict for $case", ({ none, verdict }) => {
      const readings = cycles({
        repset: [100, 100, 100, 100],
        baseline: [100, 100, 100, 100],
        none,
      });

      const text = report([run(readings)], GAP);

      expect(text).toMatch(wordsInOrder("none - baseline", verdict));
    });
  });

  describe("when readings split into speed levels", () => {
    const readings = cycles({
      repset: [100, 100, 100, 100, 200],
      baseline: [100, 100, 100, 100, 100],
      none: [100, 100, 100, 100, 100],
    });

    it("counts each side's readings on every level", () => {
      const text = report([run(readings)], GAP);

      expect(text).toContain("  repset: level 0 4, level 1 1\n  baseline: level 0 5, level 1 0\n");
    });

    it("tests each side's share off level 0 against none's", () => {
      const text = report([run(readings)], GAP);

      expect(text).toContain("  repset vs none: off level 0 20.0% vs 0.0%, p=0.2918");
    });

    it("compares each side with none, then each other side with repset", () => {
      const text = report([run(readings)], GAP);

      expect(labels(text, "vs")).toStrictEqual([
        "repset vs none",
        "baseline vs none",
        "baseline vs repset",
      ]);
    });

    it("keeps neighbors within the level gap it is given on one level", () => {
      const text = report([run(readings)], 150);

      expect(text).toContain("  repset: level 0 5\n");
    });
  });

  describe("when describing each level", () => {
    const readings = [
      reading({
        side: "none",
        cpuStart: 0,
        cpuEnd: 0,
        firstHalfMedian: 100,
        secondHalfMedian: 101,
      }),
      reading({
        side: "none",
        cpuStart: 0,
        cpuEnd: 1,
        firstHalfMedian: 100,
        secondHalfMedian: 200,
      }),
      reading({
        side: "none",
        cpuStart: 3,
        cpuEnd: 3,
        firstHalfMedian: null,
        secondHalfMedian: null,
      }),
      reading({
        side: "spin",
        cpuStart: null,
        cpuEnd: 2,
        firstHalfMedian: 99,
        secondHalfMedian: 100,
      }),
      reading({ side: "baseline", cpuStart: 5, cpuEnd: 6 }),
      ...[100, 300, 200, 150].map((sampleCount) => reading({ sampleCount })),
      reading({ median: 200, sampleCount: 50 }),
    ];

    it("counts variant readings by start CPU, by CPU change and by halves on one level", () => {
      const text = report([run(readings)], GAP);

      expect(text).toContain(
        "level 0:\n  variants by cpuStart: 0 2, 3 1, null 1; cpuStart != cpuEnd 1; halves on one level 2\n",
      );
    });

    it("gives the repset sample counts' min, median and max per level", () => {
      const text = report([run(readings)], GAP);

      expect(text).toContain("  repset sampleCount: min 100 median 175 max 300\nlevel 1:\n");
      expect(text).toContain("level 1:\n  repset sampleCount: min 50 median 50 max 50\n");
    });
  });

  describe("when rolling up each attempt", () => {
    it("counts the cycles with both repset and baseline per body, over every pinning", () => {
      const runs = [
        run(
          [
            ...cycles({ repset: [100, 100, 100, 100], baseline: [100, 100, 100] }),
            ...cycles({ repset: [100, 100], baseline: [100, 100] }, "inlined"),
          ],
          { header: { cpuModel: null } },
        ),
        run(cycles({ repset: [100, 100], baseline: [100, 100] }), {
          file: "runs/b.jsonl",
          header: { cpuModel: null, pinned: false },
        }),
      ];

      const text = report(runs, GAP);

      expect(text).toMatch(
        /^attempt 7\/1: azure, unknown, pinned\+unpinned, pairs each 5 inlined 2, forms none$/mu,
      );
    });

    it.each([
      { case: "one level", repset: [100, 100, 100, 100], forms: "none" },
      { case: "a second level above 5 %", repset: [100, 100, 100, 200], forms: "levels" },
      {
        case: "a second level under 5 %",
        repset: [100, 100, 100, 100, 100, 100, 200],
        forms: "none",
      },
      {
        case: "repset steadily above baseline",
        repset: [101, 102, 101, 102],
        forms: "steady offset",
      },
      { case: "repset steadily below baseline", repset: [99, 98, 99, 98], forms: "none" },
      {
        case: "an offset on level 0 hidden by a slow cycle",
        repset: [101, 102, 101, 102, 200],
        forms: "levels, steady offset",
      },
    ])("shows forms $forms for $case", ({ repset, forms }) => {
      const flat = repset.map(() => 100);
      const readings = cycles({ repset, baseline: flat, none: flat });

      const text = report([run(readings)], GAP);

      expect(text).toMatch(new RegExp(String.raw`^attempt .*, forms ${forms}$`, "mu"));
    });
  });
});
