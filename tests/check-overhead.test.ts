import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkedBaselineMedian, repsetReading, runCheck } from "../scripts/check-overhead.js";
import type { Readers, RepsetReading, Scenario } from "../scripts/check-overhead.js";
import type { FailedResult, MeasuredResult, Report } from "../src/report.js";
import { measured } from "./fake-children.js";
import { temporaryDir } from "./temporary-dir.js";

/** A repset reading whose timing lasted its `minTime`. */
const READING: RepsetReading = {
  median: 1000,
  callsPerSample: 10,
  sampleCount: 64,
  timerResolutionNs: 40,
  timingMs: 1010,
  minTime: 1000,
};

/** Readers for every scenario: baseline medians of 1000, and repset readings whose timing lasted their `minTime`. */
const READERS: Readers = {
  repset: () => READING,
  baseline: () => 1000,
};

const SCENARIO: Scenario = { runtime: "bun", countMode: "one-call", body: "inlined" };

/** A failed result whose case failed in `teardown` with the message `banana spilled`. */
const FAILED_RESULT: FailedResult = {
  id: "loop",
  name: "loop",
  contender: null,
  params: {},
  file: "loop.bench.ts",
  runtime: { name: "bun", version: "1.2.0" },
  setupPerCall: false,
  status: "failed",
  error: {
    phase: "teardown",
    message: "banana spilled",
    stack: null,
    teardownError: null,
    output: "",
  },
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

/** A schema-1 report holding `results`. */
function report(results: Report["results"]): Report {
  return {
    schema: 1,
    repset: "0.0.0",
    startedAt: "2026-01-01T00:00:00.000Z",
    interrupted: false,
    options: {
      runtimes: ["bun"],
      files: ["loop.bench.ts"],
      filter: null,
      minTime: 1000,
      minSamples: 64,
      rounds: null,
      seed: null,
      timeout: 60_000,
      nodeImport: null,
      rawSamples: false,
    },
    machine: { os: "darwin", arch: "arm64", cpu: null, cores: null },
    results,
    contests: [],
  };
}

const FAILED_REPORT_TEXT = JSON.stringify(report([FAILED_RESULT]));

/** A result measured at a median of 250 ns, at `callsPerSample` fixed or calibrated as `fixed` says. */
function measuredResult(callsPerSample: number, fixed: boolean): MeasuredResult {
  const { stats, sampling, checks, gc } = measured(250);
  return {
    ...FAILED_RESULT,
    status: "ok",
    error: null,
    median: stats.median,
    processes: [
      {
        round: 1,
        orderInRound: 1,
        stats,
        sampling: { ...sampling, callsPerSample, callsPerSampleFixed: fixed },
        checks,
        gc,
        rawSamples: null,
      },
    ],
  };
}

/** The path of a report file in a fresh directory holding `text`, or no file when `text` is undefined. */
function reportFile(text: string | undefined): string {
  const path = join(temporaryDir("check-overhead-test-"), "report.json");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

describe("runCheck", () => {
  describe("when every scenario passes", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });
  });
});

describe("repsetReading", () => {
  describe("when its report holds a failed result", () => {
    it.each([{ status: 1 }, { status: 0 }])(
      "throws naming the scenario, the failed phase and the message when repset exits $status",
      ({ status }) => {
        const path = reportFile(FAILED_REPORT_TEXT);

        const read = (): RepsetReading => repsetReading(SCENARIO, { status, signal: null }, path);

        expect(read).toThrow(/bun one-call inlined.*teardown.*banana spilled/v);
      },
    );
  });

  describe("when repset ends without a failed result to report", () => {
    it.each([
      {
        when: "it exits with another status",
        exit: { status: 2, signal: null },
        text: FAILED_REPORT_TEXT,
        ended: /bun one-call inlined.*\b2\b/v,
      },
      {
        when: "a signal kills it",
        exit: { status: null, signal: "SIGKILL" },
        text: FAILED_REPORT_TEXT,
        ended: /bun one-call inlined.*\bSIGKILL\b/v,
      },
      {
        when: "it exits 1 and writes no report",
        exit: { status: 1, signal: null },
        text: undefined,
        ended: /bun one-call inlined.*\b1\b/v,
      },
      {
        when: "it exits 1 and its report file holds JSON that is not a report",
        exit: { status: 1, signal: null },
        text: JSON.stringify({ ...report([]), results: FAILED_RESULT }),
        ended: /bun one-call inlined.*\b1\b/v,
      },
      {
        when: "it exits 1 and its report holds no failed result",
        exit: { status: 1, signal: null },
        text: JSON.stringify(report([])),
        ended: /bun one-call inlined.*\b1\b/v,
      },
    ] as const)(
      "throws naming the scenario and how repset ended when $when",
      ({ exit, text, ended }) => {
        const path = reportFile(text);

        const read = (): RepsetReading => repsetReading(SCENARIO, exit, path);

        expect(read).toThrow(ended);
      },
    );
  });

  describe("when repset exits 0", () => {
    const CLEAN = { status: 0, signal: null } as const;

    it("reads the result's median, counts, timer resolution and timing, with the report's minTime", () => {
      const result = measuredResult(1, true);
      const path = reportFile(JSON.stringify(report([result])));

      const reading = repsetReading(SCENARIO, CLEAN, path);

      const { stats, sampling } = result.processes[0];
      expect(reading).toStrictEqual({
        median: stats.median,
        callsPerSample: 1,
        sampleCount: stats.sampleCount,
        timerResolutionNs: sampling.timerResolutionNs,
        timingMs: sampling.timingMs,
        minTime: 1000,
      });
    });

    it.each([
      { why: "writes no report", text: undefined },
      {
        why: "writes a report holding two results",
        text: JSON.stringify(report([measuredResult(1, true), measuredResult(1, true)])),
      },
    ])("throws naming the scenario and the report when it $why", ({ text }) => {
      const path = reportFile(text);

      const read = (): RepsetReading => repsetReading(SCENARIO, CLEAN, path);

      expect(read).toThrow(/bun one-call inlined/v);
      expect(read).toThrow(path);
    });

    it.each([
      {
        scenario: SCENARIO,
        why: "a one-call scenario calibrated",
        count: 7,
        fixed: false,
        reported: "7 calibrated",
      },
      {
        scenario: SCENARIO,
        why: "a one-call scenario fixed at another count",
        count: 2,
        fixed: true,
        reported: "2 fixed",
      },
      {
        scenario: { ...SCENARIO, countMode: "calibrated" },
        why: "a calibrated scenario fixed",
        count: 1,
        fixed: true,
        reported: "1 fixed",
      },
    ] as const)(
      "throws naming the scenario and the count for $why",
      ({ scenario, count, fixed, reported }) => {
        const path = reportFile(JSON.stringify(report([measuredResult(count, fixed)])));

        const read = (): RepsetReading => repsetReading(scenario, CLEAN, path);

        expect(read).toThrow(/bun \S+ inlined/v);
        expect(read).toThrow(reported);
      },
    );
  });
});

describe("checkedBaselineMedian", () => {
  describe("when the baseline child ends badly", () => {
    it.each([
      {
        when: "it exits non-zero",
        exit: { status: 3, signal: null },
        ended: /bun one-call inlined.*\b3\b/v,
      },
      {
        when: "a signal kills it",
        exit: { status: null, signal: "SIGTERM" },
        ended: /bun one-call inlined.*\bSIGTERM\b/v,
      },
    ] as const)(
      "throws naming the scenario and how the baseline ended when $when",
      ({ exit, ended }) => {
        const median = (): number => checkedBaselineMedian(SCENARIO, exit, "");

        expect(median).toThrow(ended);
      },
    );
  });

  describe("when the baseline child exits 0", () => {
    it("returns the median it printed", () => {
      const median = checkedBaselineMedian(
        SCENARIO,
        { status: 0, signal: null },
        '{"median":12.5}\n',
      );

      expect(median).toBe(12.5);
    });

    it.each([
      { why: "something that is not JSON", stdout: "banana" },
      { why: "a median that is not a number", stdout: '{"median":"12.5"}' },
    ])("throws naming the scenario when it printed $why", ({ stdout }) => {
      const median = (): number =>
        checkedBaselineMedian(SCENARIO, { status: 0, signal: null }, stdout);

      expect(median).toThrow(/bun one-call inlined/v);
    });
  });
});
