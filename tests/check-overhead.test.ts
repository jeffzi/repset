import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkedBaselineMedian, repsetReading, runCheck } from "../scripts/check-overhead.js";
import type { Readers, RepsetReading, Scenario } from "../scripts/check-overhead.js";
import type { FailedResult, Report } from "../src/report.js";
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
        ending: "exited with status 2",
      },
      {
        when: "a signal kills it",
        exit: { status: null, signal: "SIGKILL" },
        text: FAILED_REPORT_TEXT,
        ending: "was killed by SIGKILL",
      },
      {
        when: "it exits 1 and writes no report",
        exit: { status: 1, signal: null },
        text: undefined,
        ending: "exited with status 1",
      },
      {
        when: "it exits 1 and its report file holds JSON that is not a report",
        exit: { status: 1, signal: null },
        text: JSON.stringify({ ...report([]), results: FAILED_RESULT }),
        ending: "exited with status 1",
      },
      {
        when: "it exits 1 and its report holds no failed result",
        exit: { status: 1, signal: null },
        text: JSON.stringify(report([])),
        ending: "exited with status 1",
      },
    ] as const)(
      "throws naming the scenario and how repset ended when $when",
      ({ exit, text, ending }) => {
        const path = reportFile(text);

        const read = (): RepsetReading => repsetReading(SCENARIO, exit, path);

        expect(read).toThrow(`bun one-call inlined: repset ${ending}`);
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
        ending: "exited with status 3",
      },
      {
        when: "a signal kills it",
        exit: { status: null, signal: "SIGTERM" },
        ending: "was killed by SIGTERM",
      },
    ] as const)(
      "throws naming the scenario and how the baseline ended when $when",
      ({ exit, ending }) => {
        const median = (): number => checkedBaselineMedian(SCENARIO, exit, "");

        expect(median).toThrow(/bun one-call inlined/v);
        expect(median).toThrow(ending);
      },
    );
  });
});
