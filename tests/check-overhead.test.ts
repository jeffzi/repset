import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkedBaselineMedian,
  baselineCommand,
  repsetCommand,
  repsetReading,
  runCheck,
  takeRound,
} from "../scripts/check-overhead.js";
import type { Scenario, Readers, RepsetReading } from "../scripts/check-overhead.js";
import { summarizeRound } from "../scripts/check-overhead/verdict.js";
import type { SamplingReport } from "../src/child.js";
import type { FailedResult, MeasuredResult, Report, Result } from "../src/report.js";
import {
  constantMedians,
  constantRound,
  PAIRS,
  SAME_SIGN_P_VALUE,
} from "./check-overhead/rounds.js";
import { temporaryDir } from "./temporary-dir.js";

const CALIBRATED: Scenario = { runtime: "node", countMode: "calibrated", body: "each" };
const ONE_CALL: Scenario = { runtime: "bun", countMode: "one-call", body: "inlined" };

/** Every scenario's name, in the order the check judges them. */
const SCENARIO_NAMES = [
  "node calibrated each",
  "node calibrated inlined",
  "node one-call each",
  "node one-call inlined",
  "bun calibrated each",
  "bun calibrated inlined",
  "bun one-call each",
  "bun one-call inlined",
];

/** The name the check prints for `scenario`. */
function nameOf(scenario: Scenario): string {
  return `${scenario.runtime} ${scenario.countMode} ${scenario.body}`;
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
  file: "scripts/check-overhead/overhead.bench.ts",
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
      files: ["scripts/check-overhead/overhead.bench.ts"],
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

/** A repset reading above the timing floors, with `overrides` replacing the defaults. */
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
 * Readers for every scenario: baseline medians of 1000, and repset readings whose fields
 * `repsetFor` replaces, given the scenario's name and the 1-based count of that scenario's repset
 * readings so far.
 */
function createReaders(
  repsetFor: (name: string, call: number) => Partial<RepsetReading> = () => ({}),
): Readers {
  const calls = new Map<string, number>();
  return {
    repset: async (scenario) => {
      const name = nameOf(scenario);
      const call = (calls.get(name) ?? 0) + 1;
      calls.set(name, call);
      return createReading(repsetFor(name, call));
    },
    baseline: async () => 1000,
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
      scenario: CALIBRATED,
      runtime: "node",
      own: "overhead/each",
      other: "overhead/inlined",
      calls: undefined,
    },
    {
      scenario: ONE_CALL,
      runtime: "bun",
      own: "overhead/inlined",
      other: "overhead/each",
      calls: "1",
    },
  ])(
    "runs $own on $runtime with REPSET_CALLS_PER_SAMPLE $calls",
    ({ scenario, runtime, own, other, calls }) => {
      const command = repsetCommand(scenario, "/reports/out.json", {
        REPSET_CALLS_PER_SAMPLE: "7",
      });

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
      label: "a calibrated scenario",
      scenario: CALIBRATED,
      callsPerSample: 25,
      callsPerSampleFixed: false,
    },
    {
      label: "a one-call scenario",
      scenario: ONE_CALL,
      callsPerSample: 1,
      callsPerSampleFixed: true,
    },
  ])(
    "reads the result's process for $label",
    ({ scenario, callsPerSample, callsPerSampleFixed }) => {
      const path = writeReport(
        JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample, callsPerSampleFixed })]),
        ),
      );

      const reading = repsetReading(scenario, 0, path);

      expect(reading).toStrictEqual({
        median: 937.5,
        callsPerSample,
        sampleCount: 42_000,
        timerResolutionNs: 41.7,
        timingMs: 1003.4,
        minTime: 1000,
      });
    },
  );

  describe("when the reading cannot be trusted", () => {
    it.each([
      {
        label: "the command exits non-zero",
        scenario: CALIBRATED,
        status: 3,
        content: JSON.stringify(createReport([createMeasuredResult()])),
        words: ["3"],
      },
      {
        label: "the report is not JSON",
        scenario: CALIBRATED,
        status: 0,
        content: "banana",
        words: [],
      },
      {
        label: "the report is not a report",
        scenario: CALIBRATED,
        status: 0,
        content: "{}",
        words: [],
      },
      {
        label: "the report holds no result",
        scenario: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([])),
        words: [],
      },
      {
        label: "the report holds two results",
        scenario: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([createMeasuredResult(), createMeasuredResult()])),
        words: [],
      },
      {
        label: "the result failed",
        scenario: CALIBRATED,
        status: 0,
        content: JSON.stringify(createReport([createFailedResult()])),
        words: ["fn", "kiwi"],
      },
      {
        label: "a one-call scenario's process reports a count other than 1",
        scenario: ONE_CALL,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 2, callsPerSampleFixed: true })]),
        ),
        words: ["2"],
      },
      {
        label: "a one-call scenario's process reports a count it did not fix",
        scenario: ONE_CALL,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 1, callsPerSampleFixed: false })]),
        ),
        words: [],
      },
      {
        label: "a calibrated scenario's process reports a fixed count",
        scenario: CALIBRATED,
        status: 0,
        content: JSON.stringify(
          createReport([createMeasuredResult({ callsPerSample: 25, callsPerSampleFixed: true })]),
        ),
        words: [],
      },
    ])("throws naming the scenario when $label", ({ scenario, status, content, words }) => {
      const path = writeReport(content);
      const name = nameOf(scenario);

      expect(() => repsetReading(scenario, status, path)).toThrow(mentioning(name, ...words));
    });

    it("throws naming the scenario when the report file is missing", () => {
      const path = join(temporaryDir("overhead-report-"), "missing.json");

      expect(() => repsetReading(CALIBRATED, 0, path)).toThrow(mentioning("node calibrated each"));
    });
  });
});

describe("baselineCommand", () => {
  const baselineChild = fileURLToPath(
    new URL("../scripts/check-overhead/baseline-child.ts", import.meta.url),
  );

  it.each([
    {
      scenario: CALIBRATED,
      executable: process.execPath,
      args: ["--import", "tsx", "--expose-gc", baselineChild, "each", "10", "64"],
    },
    {
      scenario: ONE_CALL,
      executable: "bun",
      args: ["--expose-gc", baselineChild, "inlined", "10", "64"],
    },
  ])(
    "runs the baseline child on $scenario.runtime at the given counts",
    ({ scenario, executable, args }) => {
      const command = baselineCommand(scenario, { callsPerSample: 10, sampleCount: 64 });

      expect(command).toStrictEqual({ executable, args });
    },
  );
});

describe("checkedBaselineMedian", () => {
  it("returns the median a child that exited 0 printed", () => {
    const median = checkedBaselineMedian(CALIBRATED, 0, '{"median":937.5}\n');

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
    "throws naming the scenario when the child exits $status printing $stdout",
    ({ status, stdout }) => {
      expect(() => checkedBaselineMedian(CALIBRATED, status, stdout)).toThrow(
        mentioning("node calibrated each"),
      );
    },
  );
});

describe("takeRound", () => {
  it("runs repset first, then alternates, a baseline-first pair at the previous pair's counts", async () => {
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
      baseline: async (_scenario, counts) => counts.callsPerSample * 1000 + counts.sampleCount,
    };

    const round = await takeRound(CALIBRATED, readers);

    // Each per-call resolution is the pair's own timer resolution over the fewer calls of its two
    // readings.
    expect(round.pairs).toStrictEqual({
      baseline: [1101, 1101, 3103, 3103, 5105, 5105, 7107, 7107, 9109, 9109, 11_111, 11_111],
      repset: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      perCallResolutions: [
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

  it("ties a baseline-first pair within a millionth of the per-call resolution at its baseline reading's fewer calls", async () => {
    // Baseline-first pairs read baseline at 8 calls and repset at 9: 41e-6 / 8 = 5.125e-6 ns ties
    // 5e-6 ns.
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
      baseline: async () => 1000,
    };

    const { pairs } = await takeRound(CALIBRATED, readers);

    expect(summarizeRound(pairs.baseline, pairs.repset, pairs.perCallResolutions).pValue).toBe(1);
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
      baseline: async () => exclusive(1000),
    };

    const round = await takeRound(CALIBRATED, readers);

    expect(round.pairs).toMatchObject(constantMedians(1000, 1000));
  });
});

describe("runCheck", () => {
  it("judges Node then Bun, calibrated then one-call, each then inlined", async () => {
    const { lines } = await checkWith(createReaders());

    const firstLines = SCENARIO_NAMES.map((name) => lines.findIndex((line) => line.includes(name)));
    expect(firstLines).not.toContain(-1);
    expect(firstLines).toStrictEqual(firstLines.toSorted((a, b) => a - b));
  });

  it("prints a calibrated scenario's smallest span in resolutions and shortest timing", async () => {
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
    const evenP = summarizeRound(
      even.baseline,
      even.repset,
      even.perCallResolutions,
    ).pValue.toFixed(4);
    const confirmedP = SAME_SIGN_P_VALUE.toFixed(4);
    const pairLines = (name: string, round: string, repset: string): string[] =>
      Array.from(
        { length: PAIRS },
        (_, index) =>
          `${name}  ${round} round, pair ${index + 1}:  baseline 1000  repset ${repset}`,
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
        `node one-call each  first round  baseline 1000.0 ns  repset 1000.0 ns  gap +0.00%  mean diff +0.00 ns  p=${evenP}`,
        ...pairLines("node one-call each", "first", "1000"),
        "node one-call each  pass",
      ],
      slower: [
        `bun one-call each  first round  baseline 1000.0 ns  repset 1100.0 ns  gap +10.00%  mean diff +100.00 ns  p=${confirmedP}`,
        ...pairLines("bun one-call each", "first", "1100.0000001"),
        `bun one-call each  confirmation round  baseline 1000.0 ns  repset 1100.0 ns  gap +10.00%  mean diff +100.00 ns  p=${confirmedP}`,
        ...pairLines("bun one-call each", "confirmation", "1100.0000001"),
        "bun one-call each  FAIL",
      ],
      faster: [
        `node one-call inlined  first round  baseline 1000.0 ns  repset 900.0 ns  gap -10.00%  mean diff -100.00 ns  p=${confirmedP}`,
        ...pairLines("node one-call inlined", "first", "899.9999999"),
        `node one-call inlined  confirmation round  baseline 1000.0 ns  repset 900.0 ns  gap -10.00%  mean diff -100.00 ns  p=${confirmedP}`,
        ...pairLines("node one-call inlined", "confirmation", "899.9999999"),
        "node one-call inlined  FAIL",
      ],
    });
  });

  describe("exit status", () => {
    it("is 0 when every scenario passes and every calibrated reading stays above its timing floors", async () => {
      const { status } = await checkWith(createReaders());

      expect(status).toBe(0);
    });

    it("is 1 when a scenario fails", async () => {
      const readers = createReaders((name) =>
        name === "bun one-call each" ? { median: 1100 } : {},
      );

      const { status } = await checkWith(readers);

      expect(status).toBe(1);
    });
  });

  describe("the timing floors", () => {
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

    it("prints a confirmation-round reading with its pair's number in that round", async () => {
      // Every reading slower than the baseline loop takes a confirmation round; its third pair is
      // call 15.
      const readers = createReaders((name, call) =>
        name === "node calibrated inlined"
          ? { median: 1100, ...(call === 15 ? { timingMs: 900 } : {}) }
          : {},
      );

      const { lines } = await checkWith(readers);

      expect(lines).toContainEqual(naming("node calibrated inlined", "confirmation", "3", "900"));
    });

    it("never checks a one-call scenario's readings", async () => {
      // 1000 ns × 10 calls / 1000 ns spans 10 resolutions.
      const readers = createReaders((name) =>
        name.includes("one-call") ? { timerResolutionNs: 1000, timingMs: 5 } : {},
      );

      const { status } = await checkWith(readers);

      expect(status).toBe(0);
    });
  });
});
