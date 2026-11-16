import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkedPlainMedian,
  plainCommand,
  repsetCommand,
  repsetReading,
  runCheck,
  takeRound,
} from "../scripts/overhead-check.js";
import type { Cell, Readers, RepsetReading } from "../scripts/overhead-check.js";
import { exitStatus, judgeCell, summarizeCell } from "../scripts/overhead-check/verdict.js";
import type { CellSummary, CellVerdict, Pairs } from "../scripts/overhead-check/verdict.js";
import type { SamplingReport } from "../src/child.js";
import type { FailedResult, MeasuredResult, Report, Result } from "../src/report.js";
import { temporaryDir } from "./temporary-dir.js";

const PAIRS = 12;
/** Two-sided sign-test p-value when all twelve pairs differ in the same direction. */
const SAME_SIGN_P_VALUE = 2 / 4096;
/** The step of a pair taken at a 41 ns clock resolution and one call per sample. */
const ONE_CALL_STEP = 41;
const ONE_CALL_STEPS = Array.from({ length: PAIRS }, () => ONE_CALL_STEP);

/** Builds twelve per-process medians on each side, every plain one and every repset one set to one value each. */
function constantMedians(plain: number, repset: number): Omit<Pairs, "steps"> {
  return {
    plain: Array.from({ length: PAIRS }, () => plain),
    repset: Array.from({ length: PAIRS }, () => repset),
  };
}

/** Builds a round of twelve pairs at the one-call step with constant medians on each side. */
function constantRound(plain: number, repset: number): Pairs {
  return { ...constantMedians(plain, repset), steps: ONE_CALL_STEPS };
}

const SLOWER_REPSET = constantRound(100, 110);
const FASTER_REPSET = constantRound(100, 90);
const NOISE: Pairs = {
  plain: Array.from({ length: PAIRS }, () => 100),
  repset: Array.from({ length: PAIRS }, (_, index) => (index % 2 === 0 ? 101 : 99)),
  steps: ONE_CALL_STEPS,
};
/** Twelve pairs whose medians differ only by float rounding: the two doubles one timed span of 22 clock ticks read as on Bun. */
const ROUNDING_ONLY = constantRound(916.9999999585343, 917.0000000153777);

const SLOWER_SUMMARY: CellSummary = {
  plainMedian: 100,
  repsetMedian: 110,
  gap: 0.1,
  pValue: SAME_SIGN_P_VALUE,
  meanDifference: 10,
};
const FASTER_SUMMARY: CellSummary = {
  plainMedian: 100,
  repsetMedian: 90,
  gap: -0.1,
  pValue: SAME_SIGN_P_VALUE,
  meanDifference: -10,
};
const NOISE_SUMMARY: CellSummary = {
  plainMedian: 100,
  repsetMedian: 100,
  gap: 0,
  pValue: 1,
  meanDifference: 0,
};

const TIED_MEDIAN = 917;
const TIED_PLAIN = [800, 800, 800, 917, 917, 917, 917, 917, 1000, 1000, 1000, 1000];

/** Builds a round whose seven outer pairs differ by `shift` while both sides' medians stay 917. */
function tiedMedianRound(shift: number): Pairs {
  return {
    plain: TIED_PLAIN,
    repset: TIED_PLAIN.map((value) => (value === TIED_MEDIAN ? value : value + shift)),
    steps: ONE_CALL_STEPS,
  };
}

/** Seven pairs differing by `shift` and five tied: 2 * 2^5 of the 2^12 sign assignments. */
function tiedMedianSummary(shift: number): CellSummary {
  return {
    plainMedian: TIED_MEDIAN,
    repsetMedian: TIED_MEDIAN,
    gap: 0,
    pValue: 64 / 4096,
    meanDifference: (7 * shift) / PAIRS,
  };
}

/** Six pairs 1 ns apart one way and six 30 ns apart the other, at the one-call step. */
function splitRound(sign: 1 | -1): Pairs {
  return {
    ...constantRound(100, 100),
    repset: Array.from({ length: PAIRS }, (_, index) => 100 + sign * (index < 6 ? -1 : 30)),
  };
}

/** Fresh-round source that fails the test when the verdict asks for a confirmation round. */
function noFreshRound(): Pairs {
  throw new Error("fresh round requested");
}

/** Builds a verdict with a fixed first-round summary. */
function createVerdict(passed: boolean): CellVerdict {
  return { passed, first: NOISE_SUMMARY };
}

describe("summarizeCell", () => {
  describe("when the pair count is odd", () => {
    it("reports the middle value as each median", () => {
      const summary = summarizeCell([3, 1, 2], [6, 4, 5], [41, 41, 41]);

      expect([summary.plainMedian, summary.repsetMedian]).toStrictEqual([2, 5]);
    });
  });

  describe("when the pair count is even", () => {
    it("reports the mean of the two middle values as each median", () => {
      const summary = summarizeCell([4, 1, 3, 2], [8, 2, 6, 4], [41, 41, 41, 41]);

      expect([summary.plainMedian, summary.repsetMedian]).toStrictEqual([2.5, 5]);
    });
  });

  describe("gap", () => {
    it("is the repset median's difference from the plain median, relative to the plain median", () => {
      const summary = summarizeCell([2], [5], [41]);

      expect(summary.gap).toBe(1.5);
    });
  });

  describe("p-value", () => {
    it.each([
      { label: "all differences zero", plain: [5, 5, 5], repset: [5, 5, 5], expected: 1 },
      { label: "differences [1, -1]", plain: [10, 10], repset: [11, 9], expected: 1 },
      // Paired by sorted rank these would read differences [1, 1] and p = 2/4.
      { label: "pairs taken by index", plain: [1, 10], repset: [11, 2], expected: 1 },
      {
        label: "ties that differ only by float rounding",
        plain: [1, 1, 1],
        repset: [1.1, 1.2, 0.9],
        expected: 6 / 8,
      },
      {
        // The two doubles one timed span of 22 clock ticks read as on Bun, 5.7e-8 ns apart.
        label: "pairs whose medians differ only by float rounding",
        plain: [916.9999999585343, 916.9999999585343, 916.9999999585343],
        repset: [917.0000000153777, 917.0000000153777, 917.0000000153777],
        expected: 1,
      },
      // At 8 calls per sample the step is 41/8 ns, so a pair ties within 5.125e-6 ns.
      {
        label: "pairs 1/8 ns apart at 8 calls",
        plain: [1000, 1000, 1000],
        repset: [1000.125, 1000.125, 1000.125],
        step: 41 / 8,
        expected: 0.25,
      },
      {
        label: "pairs just under a millionth of their step apart",
        plain: [1, 1, 1],
        repset: [1.0000051, 1.0000051, 1.0000051],
        step: 41 / 8,
        expected: 1,
      },
      {
        label: "pairs just over a millionth of their step apart",
        plain: [1, 1, 1],
        repset: [1.00000515, 1.00000515, 1.00000515],
        step: 41 / 8,
        expected: 0.25,
      },
      // 3e-5 ns ties at a 41 ns step and counts at a 41/8 ns one.
      {
        label: "each pair judged by its own step",
        plain: [1, 1, 1],
        repset: [1.00003, 1.00003, 1.00003],
        steps: [41 / 8, 41 / 8, 41],
        expected: 0.5,
      },
    ])("is $expected for $label", ({ plain, repset, step = ONE_CALL_STEP, steps, expected }) => {
      const summary = summarizeCell(plain, repset, steps ?? plain.map(() => step));

      expect(summary.pValue).toBe(expected);
    });
  });

  describe("mean difference", () => {
    it.each([
      {
        label: "seven pairs 41 ns higher and five tied",
        round: tiedMedianRound(41),
        expected: 287 / 12,
      },
      { label: "pairs that differ only by float rounding", round: ROUNDING_ONLY, expected: 0 },
    ])("is $expected ns for $label", ({ round, expected }) => {
      const summary = summarizeCell(round.plain, round.repset, round.steps);

      expect(summary.meanDifference).toBe(expected);
    });
  });
});

describe("judgeCell", () => {
  describe("when the first round reads p >= 0.05", () => {
    it("passes without taking a fresh round", async () => {
      const verdict = await judgeCell(NOISE, noFreshRound);

      expect(verdict).toStrictEqual({ passed: true, first: NOISE_SUMMARY });
    });
  });

  describe("when the first round reads p < 0.05", () => {
    it("fails when the fresh round also reads p < 0.05 with differences of the same sign", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => Promise.resolve(SLOWER_REPSET));

      expect(verdict).toStrictEqual({
        passed: false,
        first: SLOWER_SUMMARY,
        confirmation: SLOWER_SUMMARY,
      });
    });

    it("passes when the fresh round reads p >= 0.05", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => NOISE);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: NOISE_SUMMARY,
      });
    });

    it("passes when the fresh round reads p < 0.05 with differences of the opposite sign", async () => {
      const verdict = await judgeCell(SLOWER_REPSET, () => FASTER_REPSET);

      expect(verdict).toStrictEqual({
        passed: true,
        first: SLOWER_SUMMARY,
        confirmation: FASTER_SUMMARY,
      });
    });

    it("fails when the differences keep their sign between rounds whose medians tie", async () => {
      const verdict = await judgeCell(tiedMedianRound(41), () => tiedMedianRound(41));

      expect(verdict).toStrictEqual({
        passed: false,
        first: tiedMedianSummary(41),
        confirmation: tiedMedianSummary(41),
      });
    });

    it("passes when the differences change sign between rounds whose medians tie", async () => {
      const verdict = await judgeCell(tiedMedianRound(41), () => tiedMedianRound(-41));

      expect(verdict).toStrictEqual({
        passed: true,
        first: tiedMedianSummary(41),
        confirmation: tiedMedianSummary(-41),
      });
    });

    // Six pairs each way: the summed differences, not the count of pairs, give the direction.
    it.each([
      { label: "the same round", fresh: splitRound(1), passed: false },
      { label: "its mirror", fresh: splitRound(-1), passed: true },
    ])(
      "is passed: $passed when a split round is confirmed by $label",
      async ({ fresh, passed }) => {
        const verdict = await judgeCell(splitRound(1), () => fresh);

        expect([verdict.passed, verdict.first.pValue]).toStrictEqual([passed, 0.031_25]);
      },
    );
  });

  describe("when the pairs differ only by float rounding", () => {
    it("passes without taking a fresh round", async () => {
      const verdict = await judgeCell(ROUNDING_ONLY, noFreshRound);

      expect([verdict.passed, verdict.first.pValue]).toStrictEqual([true, 1]);
    });
  });
});

describe("exitStatus", () => {
  it.each([
    {
      label: "every cell passed",
      verdicts: [createVerdict(true), createVerdict(true)],
      expected: 0,
    },
    {
      label: "any cell failed",
      verdicts: [createVerdict(true), createVerdict(false)],
      expected: 1,
    },
  ])("is $expected when $label", ({ verdicts, expected }) => {
    const status = exitStatus(verdicts);

    expect(status).toBe(expected);
  });
});

const CALIBRATED: Cell = { runtime: "node", count: "calibrated", body: "each" };
const ONE_CALL: Cell = { runtime: "bun", count: "one-call", body: "inlined" };

/** Every cell's name, in the order the check judges them. */
const CELL_NAMES = [
  "node calibrated each",
  "node calibrated inlined",
  "node one-call each",
  "node one-call inlined",
  "bun calibrated each",
  "bun calibrated inlined",
  "bun one-call each",
  "bun one-call inlined",
];

/** The name the check prints for `cell`. */
function nameOf(cell: Cell): string {
  return `${cell.runtime} ${cell.count} ${cell.body}`;
}

/** Escapes `text` for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

/** Matches a text that holds each of `words` as a whole word, in any order. */
function mentioning(...words: string[]): RegExp {
  return new RegExp(
    `^${words.map((word) => String.raw`(?=[\s\S]*\b${escapeRegExp(word)}\b)`).join("")}`,
  );
}

/** Matches a line that holds each of `words` as a whole word, in any order. */
function naming(...words: string[]): unknown {
  return expect.stringMatching(mentioning(...words));
}

/** How a report's process sampled, with `overrides` replacing the defaults. */
function createSampling(overrides: Partial<SamplingReport> = {}): SamplingReport {
  return {
    timerResolutionNs: 41.7,
    callsPerSample: 25,
    callsPerSampleFixed: false,
    warmupSamples: 1000,
    timingAttempts: 1,
    timingMs: 1003.4,
    ...overrides,
  };
}

const RESULT_BASE = {
  id: "overhead/each",
  name: "overhead/each",
  contender: null,
  params: {},
  file: "scripts/overhead-check/overhead.bench.ts",
  runtime: { name: "node", version: "26.13.1" },
  setupPerCall: false,
} as const;

/** A measured result whose one process sampled as `sampling` says. */
function createMeasuredResult(sampling: Partial<SamplingReport> = {}): MeasuredResult {
  return {
    ...RESULT_BASE,
    status: "ok",
    error: null,
    median: 937.5,
    processes: [
      {
        round: 1,
        orderInRound: 1,
        stats: {
          min: 900,
          p25: 920,
          median: 937.5,
          p75: 950,
          p99: 1100,
          max: 2000,
          mean: 940,
          sampleCount: 42_000,
        },
        sampling: createSampling(sampling),
        checks: { ratioToEmptyBody: 120.5 },
        gc: null,
        rawSamples: null,
      },
    ],
  };
}

/** A result that failed in phase `fn` with the message `kiwi`. */
function createFailedResult(): FailedResult {
  return {
    ...RESULT_BASE,
    status: "failed",
    error: { phase: "fn", message: "kiwi", stack: null, output: "" },
    median: null,
    processes: [
      {
        round: 1,
        orderInRound: 1,
        stats: null,
        sampling: null,
        checks: null,
        gc: null,
        rawSamples: null,
      },
    ],
  };
}

/** A report of a run with the default `minTime` that holds `results`. */
function createReport(results: readonly Result[]): Report {
  return {
    schema: 1,
    repset: "0.0.0",
    startedAt: "2026-11-16T12:00:00.000Z",
    interrupted: false,
    options: {
      runtimes: ["node"],
      files: ["scripts/overhead-check/overhead.bench.ts"],
      filter: "overhead/each",
      minTime: 1000,
      minSamples: 64,
      rounds: null,
      seed: null,
      timeout: 600_000,
      nodeImport: "tsx",
      rawSamples: false,
    },
    machine: { os: "darwin", arch: "arm64", cpu: "Apple M2 Max", cores: 12 },
    results,
    contests: [],
  };
}

/** Writes `content` to a report file in a fresh directory and returns its path. */
function writeReport(content: string): string {
  const path = join(temporaryDir("overhead-report-"), "report.json");
  writeFileSync(path, content);
  return path;
}

/** A repset reading inside the calibrated-run rule, with `overrides` replacing the defaults. */
function createReading(overrides: Partial<RepsetReading> = {}): RepsetReading {
  return {
    median: 1000,
    callsPerSample: 10,
    sampleCount: 64,
    timerResolutionNs: 40,
    timingMs: 1010,
    minTime: 1000,
    ...overrides,
  };
}

/**
 * Readers for every cell: plain medians of 1000, and repset readings whose fields `repsetFor`
 * replaces, given the cell's name and the 1-based count of that cell's repset readings so far.
 */
function createReaders(
  repsetFor: (name: string, call: number) => Partial<RepsetReading> = () => ({}),
): Readers {
  const calls = new Map<string, number>();
  return {
    repset: async (cell) => {
      const name = nameOf(cell);
      const call = (calls.get(name) ?? 0) + 1;
      calls.set(name, call);
      return createReading(repsetFor(name, call));
    },
    plain: async () => 1000,
  };
}

/** Runs the check on `readers`, keeping each printed line. */
async function checkWith(readers: Readers): Promise<{ status: number; lines: string[] }> {
  const lines: string[] = [];
  const status = await runCheck(readers, (text) => {
    lines.push(...text.split("\n"));
  });
  return { status, lines };
}

describe("repsetCommand", () => {
  it.each([
    {
      cell: CALIBRATED,
      runtime: "node",
      own: "overhead/each",
      other: "overhead/inlined",
      calls: undefined,
    },
    { cell: ONE_CALL, runtime: "bun", own: "overhead/inlined", other: "overhead/each", calls: "1" },
  ])(
    "runs $own on $runtime with REPSET_CALLS_PER_SAMPLE $calls",
    ({ cell, runtime, own, other, calls }) => {
      const command = repsetCommand(cell, "/reports/out.json", { REPSET_CALLS_PER_SAMPLE: "7" });

      const valueOf = (flag: string): string | undefined =>
        command.args[command.args.indexOf(flag) + 1];
      const filter = new RegExp(valueOf("--filter") ?? "");
      expect({
        runtime: valueOf("--runtime"),
        out: valueOf("--out"),
        selectsOwn: filter.test(own),
        selectsOther: filter.test(other),
        calls: command.env["REPSET_CALLS_PER_SAMPLE"],
      }).toStrictEqual({
        runtime,
        out: "/reports/out.json",
        selectsOwn: true,
        selectsOther: false,
        calls,
      });
    },
  );
});

describe("repsetReading", () => {
  it.each([
    {
      label: "a calibrated cell",
      cell: CALIBRATED,
      callsPerSample: 25,
      callsPerSampleFixed: false,
    },
    { label: "a one-call cell", cell: ONE_CALL, callsPerSample: 1, callsPerSampleFixed: true },
  ])("reads the result's process for $label", ({ cell, callsPerSample, callsPerSampleFixed }) => {
    const path = writeReport(
      JSON.stringify(createReport([createMeasuredResult({ callsPerSample, callsPerSampleFixed })])),
    );

    const reading = repsetReading(cell, 0, path);

    expect(reading).toStrictEqual({
      median: 937.5,
      callsPerSample,
      sampleCount: 42_000,
      timerResolutionNs: 41.7,
      timingMs: 1003.4,
      minTime: 1000,
    });
  });

  describe("when the reading cannot be trusted", () => {
    it.each([
      {
        label: "the command exits non-zero",
        cell: CALIBRATED,
        status: 3,
        content: JSON.stringify(createReport([createMeasuredResult()])),
        words: ["3"],
      },
      {
        label: "the report is not JSON",
        cell: CALIBRATED,
        status: 0,
        content: "banana",
        words: [],
      },
      {
        label: "the report is not a report",
        cell: CALIBRATED,
        status: 0,
        content: "{}",
        words: [],
      },
      {
        label: "the report holds no result",
        cell: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([])),
        words: [],
      },
      {
        label: "the report holds two results",
        cell: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([createMeasuredResult(), createMeasuredResult()])),
        words: [],
      },
      {
        label: "the result failed",
        cell: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([createFailedResult()])),
        words: ["fn", "kiwi"],
      },
      {
        label: "a one-call cell's process reports a count other than 1",
        cell: ONE_CALL,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 2, callsPerSampleFixed: true })]),
        ),
        words: ["2"],
      },
      {
        label: "a one-call cell's process reports a count it did not fix",
        cell: ONE_CALL,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 1, callsPerSampleFixed: false })]),
        ),
        words: [],
      },
      {
        label: "a calibrated cell's process reports a fixed count",
        cell: CALIBRATED,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 25, callsPerSampleFixed: true })]),
        ),
        words: [],
      },
    ])("throws naming the cell when $label", ({ cell, status, content, words }) => {
      const path = writeReport(content);
      const name = nameOf(cell);

      expect(() => repsetReading(cell, status, path)).toThrow(mentioning(name, ...words));
    });

    it("throws naming the cell when the report file is missing", () => {
      const path = join(temporaryDir("overhead-report-"), "missing.json");

      expect(() => repsetReading(CALIBRATED, 0, path)).toThrow(mentioning("node calibrated each"));
    });
  });
});

describe("plainCommand", () => {
  const plainChild = fileURLToPath(
    new URL("../scripts/overhead-check/plain-child.ts", import.meta.url),
  );

  it.each([
    {
      cell: CALIBRATED,
      executable: process.execPath,
      args: ["--import", "tsx", "--expose-gc", plainChild, "each", "10", "64"],
    },
    {
      cell: ONE_CALL,
      executable: "bun",
      args: ["--expose-gc", plainChild, "inlined", "10", "64"],
    },
  ])("runs the plain child on $cell.runtime at the given counts", ({ cell, executable, args }) => {
    const command = plainCommand(cell, { callsPerSample: 10, sampleCount: 64 });

    expect(command).toStrictEqual({ executable, args });
  });
});

describe("checkedPlainMedian", () => {
  it("returns the median a child that exited 0 printed", () => {
    const median = checkedPlainMedian(CALIBRATED, 0, '{"median":937.5}\n');

    expect(median).toBe(937.5);
  });

  it.each([
    { status: 1, stdout: '{"median":937.5}\n' },
    { status: null, stdout: '{"median":937.5}\n' },
    { status: 0, stdout: "" },
    { status: 0, stdout: "banana\n" },
    { status: 0, stdout: '{"median":"937.5"}\n' },
    { status: 0, stdout: '{"median":1e400}\n' },
  ])(
    "throws naming the cell when the child exits $status printing $stdout",
    ({ status, stdout }) => {
      expect(() => checkedPlainMedian(CALIBRATED, status, stdout)).toThrow(
        mentioning("node calibrated each"),
      );
    },
  );
});

describe("takeRound", () => {
  it("runs repset first, then alternates, a plain-first pair at the previous pair's counts", async () => {
    let calls = 0;
    const readers: Readers = {
      repset: async () => {
        calls += 1;
        return createReading({
          median: calls,
          callsPerSample: calls,
          sampleCount: 100 + calls,
          timerResolutionNs: 40 + calls,
        });
      },
      plain: async (_cell, counts) => counts.callsPerSample * 1000 + counts.sampleCount,
    };

    const round = await takeRound(CALIBRATED, readers);

    // Each step is the pair's own resolution over the fewer calls of its two readings.
    expect(round.pairs).toStrictEqual({
      plain: [1101, 1101, 3103, 3103, 5105, 5105, 7107, 7107, 9109, 9109, 11_111, 11_111],
      repset: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      steps: [
        41,
        42,
        43 / 3,
        44 / 3,
        45 / 5,
        46 / 5,
        47 / 7,
        48 / 7,
        49 / 9,
        50 / 9,
        51 / 11,
        52 / 11,
      ],
    });
  });

  it("ties a plain-first pair within a millionth of the step at its plain reading's fewer calls", async () => {
    // Plain-first pairs read plain at 8 calls and repset at 9: 41e-6 / 8 = 5.125e-6 ns ties 5e-6 ns.
    let calls = 0;
    const readers: Readers = {
      repset: async () => {
        calls += 1;
        return createReading({
          median: 1000.000_005,
          callsPerSample: calls % 2 === 1 ? 8 : 9,
          timerResolutionNs: 41,
        });
      },
      plain: async () => 1000,
    };

    const { pairs } = await takeRound(CALIBRATED, readers);

    expect(summarizeCell(pairs.plain, pairs.repset, pairs.steps).pValue).toBe(1);
  });

  it("never takes two readings at once", async () => {
    let running = 0;
    async function exclusive<T>(value: T): Promise<T> {
      running += 1;
      if (running > 1) {
        throw new Error("two readings at once");
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      running -= 1;
      return value;
    }
    const readers: Readers = {
      repset: async () => exclusive(createReading()),
      plain: async () => exclusive(1000),
    };

    const round = await takeRound(CALIBRATED, readers);

    expect(round.pairs).toMatchObject(constantMedians(1000, 1000));
  });
});

describe("runCheck", () => {
  it("judges Node then Bun, calibrated then one-call, each then inlined", async () => {
    const { lines } = await checkWith(createReaders());

    const firstLines = CELL_NAMES.map((name) => lines.findIndex((line) => line.includes(name)));
    expect(firstLines).not.toContain(-1);
    expect(firstLines).toStrictEqual(firstLines.toSorted((a, b) => a - b));
  });

  it("prints a calibrated cell's smallest span in resolutions and shortest timing", async () => {
    const readers = createReaders((name, call) => {
      if (name !== "node calibrated each") {
        return {};
      }
      // 880 ns × 10 calls / 40 ns spans 220 resolutions; every other reading spans 250.
      return { ...(call === 7 ? { median: 880 } : {}), ...(call === 3 ? { timingMs: 1003 } : {}) };
    });

    const { lines } = await checkWith(readers);

    expect(lines).toContainEqual(naming("node calibrated each", "220"));
    expect(lines).toContainEqual(naming("node calibrated each", "1003"));
  });

  it("prints each round's medians, gap, mean difference, p-value and pairs, then the verdict", async () => {
    const readers = createReaders((name) => {
      if (name === "bun one-call each") return { median: 1100.000_000_1 };
      if (name === "node one-call inlined") return { median: 899.999_999_9 };
      return {};
    });
    const even = constantRound(1000, 1000);
    const evenP = summarizeCell(even.plain, even.repset, even.steps).pValue.toFixed(4);
    const confirmedP = SAME_SIGN_P_VALUE.toFixed(4);
    const pairLines = (name: string, round: string, repset: string): string[] =>
      Array.from(
        { length: PAIRS },
        (_, index) => `${name}  ${round} round, pair ${index + 1}:  plain 1000  repset ${repset}`,
      );

    const { lines } = await checkWith(readers);

    const linesOf = (name: string): string[] =>
      lines.filter((line) => line.startsWith(`${name}  `));
    expect({
      even: linesOf("node one-call each"),
      slower: linesOf("bun one-call each"),
      faster: linesOf("node one-call inlined"),
    }).toStrictEqual({
      even: [
        `node one-call each  first round  plain 1000.0 ns  repset 1000.0 ns  gap +0.00%  mean diff +0.00 ns  p=${evenP}`,
        ...pairLines("node one-call each", "first", "1000"),
        "node one-call each  pass",
      ],
      slower: [
        `bun one-call each  first round  plain 1000.0 ns  repset 1100.0 ns  gap +10.00%  mean diff +100.00 ns  p=${confirmedP}`,
        ...pairLines("bun one-call each", "first", "1100.0000001"),
        `bun one-call each  fresh round  plain 1000.0 ns  repset 1100.0 ns  gap +10.00%  mean diff +100.00 ns  p=${confirmedP}`,
        ...pairLines("bun one-call each", "fresh", "1100.0000001"),
        "bun one-call each  FAIL",
      ],
      faster: [
        `node one-call inlined  first round  plain 1000.0 ns  repset 900.0 ns  gap -10.00%  mean diff -100.00 ns  p=${confirmedP}`,
        ...pairLines("node one-call inlined", "first", "899.9999999"),
        `node one-call inlined  fresh round  plain 1000.0 ns  repset 900.0 ns  gap -10.00%  mean diff -100.00 ns  p=${confirmedP}`,
        ...pairLines("node one-call inlined", "fresh", "899.9999999"),
        "node one-call inlined  FAIL",
      ],
    });
  });

  describe("exit status", () => {
    it("is 0 when every cell passes and every calibrated reading keeps the rule", async () => {
      const { status } = await checkWith(createReaders());

      expect(status).toBe(0);
    });

    it("is 1 when a cell fails", async () => {
      const readers = createReaders((name) =>
        name === "bun one-call each" ? { median: 1100 } : {},
      );

      const { status } = await checkWith(readers);

      expect(status).toBe(1);
    });
  });

  describe("the calibrated-run rule", () => {
    it.each([
      // 600 ns × 10 calls / 40 ns spans 150 resolutions.
      { label: "a median sample under 200 resolutions", fields: { median: 600 }, shown: "150" },
      { label: "timing shorter than minTime", fields: { timingMs: 900 }, shown: "900" },
    ])("prints a first-round reading with $label, failing the check", async ({ fields, shown }) => {
      const readers = createReaders((name, call) =>
        name === "bun calibrated inlined" && call === 5 ? fields : {},
      );

      const { status, lines } = await checkWith(readers);

      expect(lines).toContainEqual(naming("bun calibrated inlined", "first", "5", shown));
      expect(status).toBe(1);
    });

    it("prints a fresh-round reading with its pair's number in that round", async () => {
      // Every reading slower than the plain loop takes a fresh round; its third pair is call 15.
      const readers = createReaders((name, call) =>
        name === "node calibrated inlined"
          ? { median: 1100, ...(call === 15 ? { timingMs: 900 } : {}) }
          : {},
      );

      const { lines } = await checkWith(readers);

      expect(lines).toContainEqual(naming("node calibrated inlined", "fresh", "3", "900"));
    });

    it("never checks a one-call cell's readings", async () => {
      // 1000 ns × 10 calls / 1000 ns spans 10 resolutions.
      const readers = createReaders((name) =>
        name.includes("one-call") ? { timerResolutionNs: 1000, timingMs: 5 } : {},
      );

      const { status } = await checkWith(readers);

      expect(status).toBe(0);
    });
  });
});
