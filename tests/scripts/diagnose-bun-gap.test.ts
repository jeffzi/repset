import { describe, expect, it } from "vitest";

import { runDiagnosis } from "../../scripts/diagnose-bun-gap.js";
import type {
  ChildRun,
  Dependencies,
  Environment,
  RepsetSample,
} from "../../scripts/diagnose-bun-gap.js";
import { errorOf } from "../helpers/error-of.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

const OUT = "out.jsonl";
const COMMIT = "0123456789abcdef";
const TIME = new Date("2026-01-02T03:04:05.000Z");

/** What the variant child prints for every run. */
const VARIANT_PRINT = {
  median: 900,
  firstHalfMedian: 880,
  secondHalfMedian: 920,
  p75: 950,
  p99: 1200,
  sampleCount: 37,
  cpuStart: 2,
  cpuEnd: 3,
};

/** An environment on a Linux runner with every file and variable present. */
const ENVIRONMENT: Environment = {
  bun: { executable: "/opt/bun/bin/bun", version: "1.3.0" },
  variables: { GITHUB_RUN_ID: "555", GITHUB_RUN_ATTEMPT: "2" },
  pid: 4242,
  cpuCount: 4,
  kernel: "6.8.0-azure",
  nodeVersion: "24.1.0",
  now: () => TIME,
};

const FILES: Readonly<Record<string, string>> = {
  "/proc/cpuinfo": "processor\t: 0\nmodel name\t: Fake CPU 9000\nflags\t: sse\n",
  "/sys/class/dmi/id/sys_vendor": "Microsoft Corporation\n",
  "/sys/class/dmi/id/product_name": "Virtual Machine\n",
};

interface Harness {
  readonly dependencies: Dependencies;
  /** Every spawn, in order. */
  readonly spawned: { command: string; args: readonly string[] }[];
  /** Every line appended to `OUT`, parsed. */
  readonly records: () => Record<string, unknown>[];
}

interface HarnessOptions {
  readonly environment?: Partial<Environment>;
  readonly files?: Readonly<Record<string, string>>;
  readonly repset?: (body: string, call: number) => RepsetSample;
  readonly spawn?: (command: string, args: readonly string[]) => ChildRun | undefined;
}

/** Builds fake dependencies that answer every child as a healthy one does, unless `spawn` overrides it. */
function harness(options: HarnessOptions = {}): Harness {
  const spawned: { command: string; args: readonly string[] }[] = [];
  const appended: string[] = [];
  const repsetCalls = new Map<string, number>();
  const files = options.files ?? FILES;
  const dependencies: Dependencies = {
    readers: {
      repset: (body) => {
        const call = repsetCalls.get(body) ?? 0;
        repsetCalls.set(body, call + 1);
        return options.repset?.(body, call) ?? { median: 1000, sampleCount: 37 };
      },
      file: (path) => files[path],
    },
    spawn: (command, args) => {
      spawned.push({ command, args });
      const override = options.spawn?.(command, args);
      if (override !== undefined) return override;
      if (command === "git") return { status: 0, stdout: `${COMMIT}\n` };
      if (command === "taskset") return { status: 0, stdout: "" };
      if (isBaselineChild(args)) {
        return { status: 0, stdout: `${JSON.stringify({ median: 1000 })}\n` };
      }
      return { status: 0, stdout: `${JSON.stringify(VARIANT_PRINT)}\n` };
    },
    append: (path, text) => {
      if (path === OUT) appended.push(text);
    },
    environment: { ...ENVIRONMENT, ...options.environment },
  };
  return {
    dependencies,
    spawned,
    records: () =>
      appended
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  };
}

/** Whether a spawn's arguments start the baseline child script. */
function isBaselineChild(args: readonly string[]): boolean {
  return args.some((arg) => arg.endsWith("baseline-child.ts"));
}

/** The records of kind `reading`, in file order. */
function readings(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => record["kind"] === "reading");
}

/** The first record of kind `header`, or `undefined` when none was written. */
function header(records: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  return records.find((record) => record["kind"] === "header");
}

describe("runDiagnosis", () => {
  describe("options", () => {
    it("rounds --cycles up to a multiple of the number of sides run", () => {
      const { dependencies, records } = harness();

      runDiagnosis(
        ["--cycles", "4", "--sides", "repset,baseline,none", "--out", OUT],
        dependencies,
      );

      expect(header(records())?.["cyclesPerBody"]).toBe(6);
    });

    it("runs 170 cycles per body, rounded up for all 13 sides, by default", () => {
      const { dependencies, records } = harness();

      runDiagnosis(["--out", OUT], dependencies);

      expect(header(records())?.["cyclesPerBody"]).toBe(182);
    });

    it("runs every side when --sides is not given", () => {
      const { dependencies, records } = harness();

      runDiagnosis(["--cycles", "1", "--out", OUT], dependencies);

      expect(header(records())?.["sides"]).toStrictEqual([
        "repset",
        "baseline",
        "none",
        "clock-wrapper",
        "sample-function",
        "stored-result",
        "indirect-access",
        "clock-between-samples",
        "timed-warmup",
        "all-six",
        "repset-buffer",
        "repset-loaded",
        "repset-sampler",
      ]);
    });

    it("rejects an unknown side, naming it", () => {
      const { dependencies } = harness();

      const error = errorOf(() => {
        runDiagnosis(["--sides", "repset,banana", "--out", OUT], dependencies);
      });

      expect(error.message).toMatch(wordsInOrder("banana"));
    });

    it("rejects a run without --out", () => {
      const { dependencies } = harness();

      const error = errorOf(() => {
        runDiagnosis(["--cycles", "3"], dependencies);
      });

      expect(error.message).toContain("--out");
    });
  });

  describe("order", () => {
    it("rotates the sides left by the cycle index and alternates the bodies cycle by cycle", () => {
      const { dependencies, records } = harness();

      runDiagnosis(
        ["--cycles", "3", "--sides", "repset,baseline,none", "--out", OUT],
        dependencies,
      );

      expect(
        readings(records()).map(({ body, cycle, position, side }) => [body, cycle, position, side]),
      ).toStrictEqual([
        ["each", 0, 0, "repset"],
        ["each", 0, 1, "baseline"],
        ["each", 0, 2, "none"],
        ["inlined", 0, 0, "repset"],
        ["inlined", 0, 1, "baseline"],
        ["inlined", 0, 2, "none"],
        ["each", 1, 0, "baseline"],
        ["each", 1, 1, "none"],
        ["each", 1, 2, "repset"],
        ["inlined", 1, 0, "baseline"],
        ["inlined", 1, 1, "none"],
        ["inlined", 1, 2, "repset"],
        ["each", 2, 0, "none"],
        ["each", 2, 1, "repset"],
        ["each", 2, 2, "baseline"],
        ["inlined", 2, 0, "none"],
        ["inlined", 2, 1, "repset"],
        ["inlined", 2, 2, "baseline"],
      ]);
    });
  });

  describe("sample count", () => {
    const firstReadings = (body: string, call: number): RepsetSample => {
      if (call > 0) return { median: 1000, sampleCount: 99 };
      return { median: 1000, sampleCount: body === "each" ? 37 : 41 };
    };

    it("runs every baseline and variant process of a body at the count of its first, unrecorded repset reading", () => {
      const { dependencies, spawned } = harness({ repset: firstReadings });

      runDiagnosis(["--cycles", "2", "--sides", "baseline,none", "--out", OUT], dependencies);

      const baselineChild = expect.stringMatching(/baseline-child\.ts$/u);
      expect(
        spawned
          .filter(({ command }) => command === ENVIRONMENT.bun.executable)
          .map(({ args }) => args.slice(-4)),
      ).toStrictEqual([
        [baselineChild, "each", "1", "37"],
        ["none", "each", "1", "37"],
        [baselineChild, "inlined", "1", "41"],
        ["none", "inlined", "1", "41"],
        ["none", "each", "1", "37"],
        [baselineChild, "each", "1", "37"],
        ["none", "inlined", "1", "41"],
        [baselineChild, "inlined", "1", "41"],
      ]);
    });

    it("reports each body's fixed count in the header", () => {
      const { dependencies, records } = harness({ repset: firstReadings });

      runDiagnosis(["--cycles", "1", "--sides", "repset", "--out", OUT], dependencies);

      expect(header(records())?.["sampleCounts"]).toStrictEqual({ each: 37, inlined: 41 });
    });
  });

  describe("records", () => {
    it("writes the header first, from the machine and the run", () => {
      const { dependencies, records } = harness();

      runDiagnosis(["--cycles", "1", "--sides", "repset", "--out", OUT], dependencies);

      expect(records()[0]).toStrictEqual({
        kind: "header",
        cpuModel: "Fake CPU 9000",
        cpuCount: 4,
        kernel: "6.8.0-azure",
        sysVendor: "Microsoft Corporation",
        productName: "Virtual Machine",
        bunVersion: "1.3.0",
        nodeVersion: "24.1.0",
        commit: COMMIT,
        runId: "555",
        runAttempt: "2",
        pinned: false,
        cyclesPerBody: 1,
        sides: ["repset"],
        sampleCounts: { each: 37, inlined: 37 },
      });
    });

    it("writes null for each machine or run detail it cannot read", () => {
      const { dependencies, records } = harness({
        environment: { variables: {} },
        files: { "/proc/cpuinfo": "processor\t: 0\nflags\t: sse\n" },
      });

      runDiagnosis(["--cycles", "1", "--sides", "repset", "--out", OUT], dependencies);

      expect(header(records())).toMatchObject({
        cpuModel: null,
        sysVendor: null,
        productName: null,
        runId: null,
        runAttempt: null,
      });
    });

    it.each([
      {
        side: "repset",
        expected: {
          median: 1000,
          sampleCount: 37,
          firstHalfMedian: null,
          secondHalfMedian: null,
          p75: null,
          p99: null,
          cpuStart: null,
          cpuEnd: null,
        },
      },
      {
        side: "baseline",
        expected: {
          median: 1000,
          sampleCount: 64,
          firstHalfMedian: null,
          secondHalfMedian: null,
          p75: null,
          p99: null,
          cpuStart: null,
          cpuEnd: null,
        },
      },
      { side: "none", expected: VARIANT_PRINT },
    ])("records a $side reading from what its process reports", ({ side, expected }) => {
      const { dependencies, records } = harness({
        repset: (_body, call) => ({ median: 1000, sampleCount: call === 0 ? 64 : 37 }),
      });

      runDiagnosis(["--cycles", "1", "--sides", side, "--out", OUT], dependencies);

      expect(readings(records())[0]).toStrictEqual({
        kind: "reading",
        cycle: 0,
        position: 0,
        body: "each",
        side,
        ...expected,
        pinnedCpu: null,
        time: TIME.toISOString(),
      });
    });

    it("keeps the records written before a later process fails", () => {
      let baselineRuns = 0;
      const { dependencies, records } = harness({
        spawn: (_command, args) => {
          if (!isBaselineChild(args)) return undefined;
          baselineRuns += 1;
          return baselineRuns === 3 ? { status: 1, stdout: "" } : undefined;
        },
      });

      errorOf(() => {
        runDiagnosis(["--cycles", "2", "--sides", "repset,baseline", "--out", OUT], dependencies);
      });

      expect(records().map(({ kind, side }) => [kind, side ?? null])).toStrictEqual([
        ["header", null],
        ["reading", "repset"],
        ["reading", "baseline"],
        ["reading", "repset"],
        ["reading", "baseline"],
      ]);
    });
  });

  describe("pinning", () => {
    it("with --pin, pins the driver to CPU (cycle mod CPU count) before each cycle of each body", () => {
      const { dependencies, spawned } = harness({ environment: { cpuCount: 2 } });

      runDiagnosis(["--cycles", "3", "--sides", "repset", "--pin", "--out", OUT], dependencies);

      expect(spawned.filter(({ command }) => command === "taskset")).toStrictEqual(
        ["0", "0", "1", "1", "0", "0"].map((cpu) => ({
          command: "taskset",
          args: ["-cp", cpu, "4242"],
        })),
      );
    });

    it("with --pin, records the CPU each reading ran pinned to", () => {
      const { dependencies, records } = harness({ environment: { cpuCount: 2 } });

      runDiagnosis(["--cycles", "3", "--sides", "repset", "--pin", "--out", OUT], dependencies);

      expect(readings(records()).map(({ pinnedCpu }) => pinnedCpu)).toStrictEqual([
        0, 0, 1, 1, 0, 0,
      ]);
    });

    it("without --pin, never runs taskset", () => {
      const { dependencies, spawned } = harness();

      runDiagnosis(["--cycles", "3", "--sides", "repset,none", "--out", OUT], dependencies);

      expect(spawned.filter(({ command }) => command === "taskset")).toStrictEqual([]);
    });
  });

  describe("failures", () => {
    it.each<{ failure: string; run: ChildRun }>([
      {
        failure: "cannot start",
        run: { error: new Error("spawn ENOENT"), status: null, stdout: "" },
      },
      { failure: "exits non-zero", run: { status: 2, stdout: "" } },
      { failure: "prints no finite median", run: { status: 0, stdout: '{"median":null}\n' } },
    ])("stops at a child that $failure, naming the side, body and cycle", ({ run }) => {
      let inlinedBaselines = 0;
      const { dependencies } = harness({
        spawn: (_command, args) => {
          if (!isBaselineChild(args) || !args.includes("inlined")) return undefined;
          inlinedBaselines += 1;
          return inlinedBaselines === 2 ? run : undefined;
        },
      });

      const error = errorOf(() => {
        runDiagnosis(["--cycles", "2", "--sides", "repset,baseline", "--out", OUT], dependencies);
      });

      expect(error.message).toMatch(wordsInOrder("baseline", "inlined", "cycle", 1));
    });

    it("stops at a repset run that fails, naming the side, body and cycle", () => {
      const { dependencies } = harness({
        repset: (body, call) => {
          if (body === "each" && call === 2) throw new Error("repset exited with code 1");
          return { median: 1000, sampleCount: 37 };
        },
      });

      const error = errorOf(() => {
        runDiagnosis(["--cycles", "2", "--sides", "repset", "--out", OUT], dependencies);
      });

      expect(error.message).toMatch(wordsInOrder("repset", "each", "cycle", 1));
    });

    it("stops when taskset fails, naming the CPU", () => {
      const { dependencies } = harness({
        environment: { cpuCount: 8 },
        spawn: (command, args) =>
          command === "taskset" && args[1] === "5" ? { status: 1, stdout: "" } : undefined,
      });

      const error = errorOf(() => {
        runDiagnosis(["--cycles", "6", "--sides", "repset", "--pin", "--out", OUT], dependencies);
      });

      expect(error.message).toMatch(wordsInOrder("CPU", 5));
    });
  });
});
