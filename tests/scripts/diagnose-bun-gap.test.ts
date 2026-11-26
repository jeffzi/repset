import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { benchName } from "../../scripts/check-timing-accuracy/bodies.js";
import { runDiagnosis } from "../../scripts/diagnose-bun-gap.js";
import type {
  ChildRun,
  Dependencies,
  Environment,
  RepsetSample,
} from "../../scripts/diagnose-bun-gap.js";
import { childRuntimeFlags } from "../../src/children.js";
import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "../../src/measure/measure.js";
import { errorOf } from "../helpers/error-of.js";
import { ROOT } from "../helpers/fixture-path.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

const OUT = "out.jsonl";
const BENCH_FILE = join(ROOT, "scripts", "check-timing-accuracy", "timing-accuracy.bench.ts");

/** The cases the bench file lists: one per body, plus one no body matches. */
const LISTED_CASES = [
  { id: "first", name: benchName("each"), contender: null, setupPerCall: false },
  { id: "decoy", name: "banana", contender: null, setupPerCall: false },
  { id: "second", name: benchName("inlined"), contender: null, setupPerCall: false },
];

/** A run of repset's child that wrote `result` on descriptor 3. */
function directRun(result: unknown): ChildRun {
  return { status: 0, stdout: "", result: `${JSON.stringify(result)}\n` };
}

/** A measuring child's result whose timing has `median` and `sampleCount`. */
function measuredResult(median: number | null, sampleCount: number): unknown {
  return {
    status: "ok",
    time: {
      stats: { min: 1, p25: 2, median, p75: 4, p99: 5, max: 6, mean: 3, sampleCount },
      sampling: {
        timerResolutionNs: 1,
        callsPerSample: 1,
        callsPerSampleFixed: true,
        warmupSampleCount: 0,
        timingAttemptCount: 1,
        timingMs: 1000,
      },
      checks: { ratioToEmptyBody: 3 },
      gc: null,
      rawSamples: null,
    },
    memory: null,
  };
}

/** The result a child writes when the case's `fn` throws. */
const FAILED_RESULT = {
  status: "failed",
  error: { phase: "fn", message: "plum", stack: null, teardownError: null },
};

/** The request a spawn hands repset's child, or `undefined` for any other spawn. */
function directRequest(args: readonly string[]): Record<string, unknown> | undefined {
  if (!args.some((arg) => /dist[/\\]child\.js$/u.test(arg))) return undefined;
  const request: unknown = JSON.parse(args.at(-1) ?? "");
  if (typeof request !== "object" || request === null) throw new TypeError("not a request");
  return { ...request };
}

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

/** The reading fields a side that reports only its median and sample count leaves null. */
const UNREPORTED = {
  firstHalfMedian: null,
  secondHalfMedian: null,
  p75: null,
  p99: null,
  cpuStart: null,
  cpuEnd: null,
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

interface Spawn {
  command: string;
  args: readonly string[];
}

interface Harness {
  readonly dependencies: Dependencies;
  /** Every spawn, in order. */
  readonly spawned: Spawn[];
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
  const spawned: Spawn[] = [];
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
      const request = directRequest(args);
      if (request?.["mode"] === "list") return directRun({ status: "ok", cases: LISTED_CASES });
      if (request !== undefined) return directRun(measuredResult(950, 70));
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

    it("runs 170 cycles per body, rounded up for all 22 sides, by default", () => {
      const { dependencies, records } = harness();

      runDiagnosis(["--out", OUT], dependencies);

      expect(header(records())?.["cyclesPerBody"]).toBe(176);
    });

    it("rounds the default 170 cycles up to 180 over twelve sides", () => {
      const { dependencies, records } = harness();

      runDiagnosis(
        [
          "--sides",
          [
            "repset",
            "baseline",
            "baseline-again",
            "none",
            "baseline-args",
            "baseline-async",
            "baseline-table",
            "baseline-proc",
            "baseline-with-variants",
            "baseline-child-modules",
            "baseline-under-parent",
            "repset-child-direct",
          ].join(","),
          "--out",
          OUT,
        ],
        dependencies,
      );

      expect(header(records())?.["cyclesPerBody"]).toBe(180);
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
        "baseline-again",
        "baseline-args",
        "baseline-async",
        "baseline-table",
        "baseline-proc",
        "baseline-with-variants",
        "baseline-child-modules",
        "baseline-under-parent",
        "repset-child-direct",
      ]);
    });

    it("runs the sides --sides names in the default order, whatever order it names them in", () => {
      const { dependencies, records } = harness();

      runDiagnosis(
        [
          "--cycles",
          "1",
          "--sides",
          "repset-child-direct,baseline-under-parent,baseline-proc,baseline-again,none,repset",
          "--out",
          OUT,
        ],
        dependencies,
      );

      expect(header(records())?.["sides"]).toStrictEqual([
        "repset",
        "none",
        "baseline-again",
        "baseline-proc",
        "baseline-under-parent",
        "repset-child-direct",
      ]);
    });

    it("rejects an unknown side, naming it", () => {
      const { dependencies } = harness();

      const error = errorOf(() => {
        runDiagnosis(["--sides", "repset,baseline-banana", "--out", OUT], dependencies);
      });

      expect(error.message).toMatch(wordsInOrder("baseline-banana"));
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

  describe("command lines", () => {
    /** The first Bun spawn of the baseline child and the first spawn of `side`, from one cycle of both. */
    function baselineAndSide(side: string): {
      baseline: Spawn;
      other: Spawn | undefined;
      fileIndex: number;
    } {
      const { dependencies, spawned } = harness();
      runDiagnosis(["--cycles", "1", "--sides", `baseline,${side}`, "--out", OUT], dependencies);
      const children = spawned.filter(({ command }) => command !== "git");
      const [baseline, other] = children;
      if (baseline === undefined) throw new Error("no baseline spawn");
      return {
        baseline,
        other,
        fileIndex: baseline.args.findIndex((arg) => isBaselineChild([arg])),
      };
    }

    it.each([
      { side: "baseline-again", file: /[/\\]check-timing-accuracy[/\\]baseline-child\.ts$/u },
      ...[
        "baseline-args",
        "baseline-async",
        "baseline-table",
        "baseline-proc",
        "baseline-with-variants",
        "baseline-child-modules",
      ].map((side) => ({
        side,
        file: new RegExp(String.raw`[/\\]diagnose-bun-gap[/\\]${side}\.ts$`, "u"),
      })),
    ])("runs $side as the baseline child is run, on its own file", ({ side, file }) => {
      const { baseline, other, fileIndex } = baselineAndSide(side);

      expect(other).toStrictEqual({
        command: ENVIRONMENT.bun.executable,
        args: baseline.args.with(fileIndex, expect.stringMatching(file)),
      });
    });

    it("runs baseline-under-parent as Node on node-parent, with the baseline child and its arguments", () => {
      const { baseline, other, fileIndex } = baselineAndSide("baseline-under-parent");

      expect(other).toStrictEqual({
        command: process.execPath,
        args: [
          expect.stringMatching(/[/\\]diagnose-bun-gap[/\\]node-parent\.ts$/u),
          ...baseline.args.slice(fileIndex),
        ],
      });
    });
  });

  describe("repset-child-direct", () => {
    it("starts Bun on dist/child.js with repset's child flags", () => {
      const { dependencies, spawned } = harness();

      runDiagnosis(["--cycles", "1", "--sides", "repset-child-direct", "--out", OUT], dependencies);

      const entry = expect.stringMatching(/[/\\]dist[/\\]child\.js$/u);
      expect(
        spawned
          .filter(({ args }) => directRequest(args) !== undefined)
          .map(({ command, args }) => ({ command, args: args.slice(0, -1) })),
      ).toStrictEqual(
        Array.from({ length: 4 }, () => ({
          command: ENVIRONMENT.bun.executable,
          args: [...childRuntimeFlags("bun", undefined), entry],
        })),
      );
    });

    it("lists the bench file once per body, then measures each body's listed case", () => {
      const { dependencies, spawned } = harness();

      runDiagnosis(["--cycles", "1", "--sides", "repset-child-direct", "--out", OUT], dependencies);

      const measure = (id: string): Record<string, unknown> => ({
        mode: "measure",
        file: BENCH_FILE,
        id,
        minTime: DEFAULT_MIN_TIME,
        minSamples: DEFAULT_MIN_SAMPLES,
        callsPerSample: 1,
        time: true,
        memory: false,
      });
      expect(spawned.map(({ args }) => directRequest(args)).filter(Boolean)).toStrictEqual([
        { mode: "list", file: BENCH_FILE },
        { mode: "list", file: BENCH_FILE },
        measure("first"),
        measure("second"),
      ]);
    });

    it.each<{ failure: string; run: ChildRun }>([
      { failure: "fails", run: directRun(FAILED_RESULT) },
      {
        failure: "lists no case for the body",
        run: directRun({ status: "ok", cases: LISTED_CASES.slice(0, 2) }),
      },
      {
        failure: "lists more than one case for the body",
        run: directRun({
          status: "ok",
          cases: [...LISTED_CASES, { ...LISTED_CASES[2], id: "third" }],
        }),
      },
    ])("stops at a list request that $failure, naming the side, body and list", ({ run }) => {
      let lists = 0;
      const { dependencies } = harness({
        spawn: (_command, args) => {
          if (directRequest(args)?.["mode"] !== "list") return undefined;
          lists += 1;
          return lists === 2 ? run : undefined;
        },
      });

      const error = errorOf(() => {
        runDiagnosis(
          ["--cycles", "1", "--sides", "repset-child-direct", "--out", OUT],
          dependencies,
        );
      });

      expect(error.message).toMatch(wordsInOrder("repset-child-direct", "inlined", "list"));
    });

    it.each<{ failure: string; run: ChildRun }>([
      {
        failure: "cannot start",
        run: { error: new Error("spawn ENOENT"), status: null, stdout: "" },
      },
      { failure: "writes no result", run: { status: 0, stdout: "" } },
      {
        failure: "writes a result that does not parse",
        run: { status: 0, stdout: "", result: "{\n" },
      },
      { failure: "writes a failed result", run: directRun(FAILED_RESULT) },
      { failure: "writes a median that is not a number", run: directRun(measuredResult(null, 70)) },
      {
        failure: "writes an infinite median",
        run: {
          status: 0,
          stdout: "",
          result: `${JSON.stringify(measuredResult(0, 70)).replace('"median":0', '"median":1e999')}\n`,
        },
      },
    ])("stops at a measuring child that $failure, naming the side, body and cycle", ({ run }) => {
      let inlinedMeasures = 0;
      const { dependencies } = harness({
        spawn: (_command, args) => {
          if (directRequest(args)?.["id"] !== "second") return undefined;
          inlinedMeasures += 1;
          return inlinedMeasures === 2 ? run : undefined;
        },
      });

      const error = errorOf(() => {
        runDiagnosis(
          ["--cycles", "2", "--sides", "repset-child-direct", "--out", OUT],
          dependencies,
        );
      });

      expect(error.message).toMatch(wordsInOrder("repset-child-direct", "inlined", "cycle", 1));
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
      { side: "repset", expected: { median: 1000, sampleCount: 37, ...UNREPORTED } },
      { side: "baseline", expected: { median: 1000, sampleCount: 64, ...UNREPORTED } },
      { side: "none", expected: VARIANT_PRINT },
      {
        side: "baseline-args",
        expected: { median: VARIANT_PRINT.median, sampleCount: 64, ...UNREPORTED },
      },
      {
        side: "baseline-proc",
        expected: {
          median: VARIANT_PRINT.median,
          sampleCount: 64,
          ...UNREPORTED,
          cpuStart: VARIANT_PRINT.cpuStart,
          cpuEnd: VARIANT_PRINT.cpuEnd,
        },
      },
      {
        side: "baseline-under-parent",
        expected: { median: 1000, sampleCount: 64, ...UNREPORTED },
      },
      {
        side: "repset-child-direct",
        expected: { median: 950, sampleCount: 70, ...UNREPORTED },
      },
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
