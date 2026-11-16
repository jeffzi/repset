import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ChildPhase, Measured, MeasureRequest, OnceRequest } from "../src/child.js";
import type {
  findRuntime,
  FoundRuntime,
  Outcome,
  StartOptions,
  startChild,
} from "../src/children.js";
import { main } from "../src/command.js";
import type { Report } from "../src/report.js";
import { formatTable, metricLine } from "../src/table.js";
import { temporaryDir } from "./temporary-dir.js";

type StartChild = typeof startChild;
type FindRuntime = typeof findRuntime;
type Runtime = FoundRuntime["runtime"];
type Asked = MeasureRequest | OnceRequest;
type Io = NonNullable<Parameters<typeof main>[1]>;

/** The benchmark files every workspace holds; the fake children never import them. */
const FILES = ["sort.bench.ts", "parse.bench.ts"];

/** The package's own version, which `--version` prints and the report records. */
const VERSION: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** The runtime the fake lookup finds for `runtime`. */
function found(runtime: Runtime): FoundRuntime {
  return {
    runtime,
    executable: `/bin/${runtime}`,
    version: runtime === "node" ? "24.1.0" : "1.3.2",
  };
}

/** A runtime lookup that finds every runtime. */
const findAny: FindRuntime = async (runtime) => found(runtime);

/** A measurement whose median is `median`. */
function measured(median: number): Measured {
  return {
    status: "ok",
    stats: { min: 1, p25: 2, median, p75: 4, p99: 5, max: 6, mean: 3.5, sampleCount: 64 },
    sampling: {
      timerResolutionNs: 41.7,
      callsPerSample: 2,
      callsPerSampleFixed: false,
      warmupSamples: 1000,
      timingAttempts: 1,
      timingMs: 1003.4,
    },
    checks: { ratioToEmptyBody: 120.5 },
    gc: { count: 3, minor: 3, major: 0, totalMs: 0.41, maxMs: 0.17 },
  };
}

/** An outcome in which the stop signal killed the child. */
const stopped: Outcome = { status: "stopped", output: "" };

/** An outcome in which the child failed in `phase` with `message`. */
function failedOutcome(phase: ChildPhase, message: string): Outcome {
  return { status: "failed", error: { phase, message, stack: null }, output: "" };
}

/** The one case the fake listing child finds in `file`. */
function caseOf(file: string): string {
  return `${basename(file, ".bench.ts")}/fast`;
}

/** A child starter listing `<file stem>/fast` per file and answering the rest with `answer`. */
function starter(
  answer: (
    request: Asked,
    runtime: FoundRuntime,
    options: StartOptions,
  ) => Outcome | Promise<Outcome>,
): StartChild {
  return async (runtime, request, options) => {
    if (request.mode === "list") {
      return {
        status: "ok",
        result: { status: "ok", cases: [{ id: caseOf(request.file), setupPerCall: false }] },
        output: "",
      };
    }
    return answer(request, runtime, options);
  };
}

/** A child starter that measures every case and runs every once case. */
const measuresAll = starter((request) =>
  request.mode === "measure"
    ? { status: "ok", result: measured(4656), output: "" }
    : { status: "ok", result: { status: "ok" }, output: "" },
);

/** A child starter that fails `parse/fast` in phase `fn` with `kiwi` and runs every other case. */
const failsParse = starter((request, runtime, options) =>
  request.id === "parse/fast"
    ? failedOutcome("fn", "kiwi")
    : measuresAll(runtime, request, options),
);

/** A child starter that lists, then fails the command with a plain error if a case starts. */
const startsNoCase = starter(() => {
  throw new Error("a case started");
});

/** A child starter that fails the command with a plain error if any child starts. */
const startsNoChild: StartChild = async () => {
  throw new Error("a child started");
};

/** A stream stand-in that keeps what is written to it. */
interface Captured {
  text: string;
  write: (text: string) => boolean;
}

/** A stream stand-in with nothing written yet. */
function captured(): Captured {
  const stream: Captured = {
    text: "",
    write: (text) => {
      stream.text += text;
      return true;
    },
  };
  return stream;
}

/** A fresh working directory holding the empty benchmark files, removed when the test ends. */
function workspace(): string {
  const dir = temporaryDir("repset-command-");
  for (const file of FILES) writeFileSync(join(dir, file), "");
  return dir;
}

interface Ended {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandIo = Omit<Partial<Io>, "stdout" | "stderr"> & {
  readonly stdout?: Captured;
  readonly stderr?: Captured;
};

/** Runs the command in `cwd` with the fake lookup, a measuring starter and a silent signal source. */
async function command(cwd: string, args: readonly string[], io: CommandIo = {}): Promise<Ended> {
  const stdout = io.stdout ?? captured();
  const stderr = io.stderr ?? captured();

  const code = await main(args, {
    cwd,
    findRuntime: findAny,
    startChild: measuresAll,
    signals: new EventEmitter(),
    ...io,
    stdout,
    stderr,
  });

  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Whether `value` has the report fields the tests read. */
function isReport(value: unknown): value is Report {
  return (
    typeof value === "object" &&
    value !== null &&
    "options" in value &&
    typeof value.options === "object" &&
    value.options !== null &&
    "results" in value &&
    Array.isArray(value.results) &&
    "interrupted" in value &&
    typeof value.interrupted === "boolean"
  );
}

/** The report `text` holds, which `source` names in the error thrown when it holds none. */
function parseReport(text: string, source: string): Report {
  const parsed: unknown = JSON.parse(text);
  if (!isReport(parsed)) throw new Error(`${source} does not hold a report`);
  return parsed;
}

/** The report the file at `path` holds. */
function reportAt(path: string): Report {
  return parseReport(readFileSync(path, "utf8"), path);
}

/** Puts a non-empty directory at `path`, so renaming a file over it fails. */
function blockWrites(path: string): void {
  rmSync(path, { force: true });
  mkdirSync(join(path, "keep"), { recursive: true });
}

/** Removes what {@link blockWrites} put at `path`. */
function unblockWrites(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Matches a line that holds each of `words` as a whole word, in any order. */
function naming(...words: string[]): unknown {
  const ahead = words
    .map((word) => `(?=.*\\b${word.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b)`)
    .join("");
  return expect.stringMatching(new RegExp(`^${ahead}`));
}

/** The lines of `text`, without the newline that ends the last one. */
function linesOf(text: string): string[] {
  return text.trimEnd().split("\n");
}

describe("main", () => {
  describe("the flags", () => {
    it("hands every option flag and the positional files to the run under the option names", async () => {
      const dir = workspace();

      const { code } = await command(dir, [
        "sort.bench.ts",
        "--runtime",
        "bun,node",
        "--filter",
        "fast",
        "--min-time",
        "2.5",
        "--min-samples",
        "8",
        "--timeout",
        "1234",
        "--node-import",
        "tsx",
        "--out",
        "report.json",
      ]);

      const { runtimes, files, filter, minTime, minSamples, timeout, nodeImport } = reportAt(
        join(dir, "report.json"),
      ).options;
      expect({
        code,
        options: { runtimes, files, filter, minTime, minSamples, timeout, nodeImport },
      }).toStrictEqual({
        code: 0,
        options: {
          runtimes: ["bun", "node"],
          files: ["sort.bench.ts"],
          filter: "fast",
          minTime: 2.5,
          minSamples: 8,
          timeout: 1234,
          nodeImport: "tsx",
        },
      });
    });

    it("records the files as null when no positional file is given", async () => {
      const dir = workspace();

      await command(dir, ["--out", "report.json"]);

      expect(reportAt(join(dir, "report.json")).options.files).toBeNull();
    });
  });

  describe("where the command line or the config is wrong", () => {
    it.each([
      { why: "an unknown flag", args: ["--banana"] },
      { why: "a value flag given twice", args: ["--filter", "sort", "--filter", "parse"] },
      { why: "an exponent", args: ["--min-time", "1e3"] },
      { why: "an empty number", args: ["--timeout", ""] },
      { why: "--metric-lines with --out -", args: ["--metric-lines", "--out", "-"] },
      { why: "--list with --once", args: ["--list", "--once"] },
      { why: "--list with --out", args: ["--list", "--out", "report.json"] },
      { why: "--list with --metric-lines", args: ["--list", "--metric-lines"] },
      { why: "--once with --out", args: ["--once", "--out", "report.json"] },
      { why: "--once with --metric-lines", args: ["--once", "--metric-lines"] },
    ])(
      "exits 2 on $why with a message on stderr, nothing on stdout, no child and no report",
      async ({ args }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

        expect({
          code,
          stdout,
          printed: stderr.length > 0,
          written: existsSync(join(dir, "report.json")),
        }).toStrictEqual({ code: 2, stdout: "", printed: true, written: false });
      },
    );

    it("exits 2 on an unknown --runtime name, naming the flag and the list", async () => {
      const { code, stderr } = await command(workspace(), ["--runtime", "node,banana"], {
        startChild: startsNoChild,
      });

      expect({
        code,
        named: stderr.includes("--runtime") && stderr.includes("node,banana"),
      }).toStrictEqual({
        code: 2,
        named: true,
      });
    });

    it("prints a failed listing's stack, then its output, then the file, phase and message last", async () => {
      const dir = workspace();
      const failsListing: StartChild = async () => ({
        status: "failed",
        error: { phase: "load", message: "kiwi", stack: "at plum" },
        output: "pear\n",
      });

      const { code, stdout, stderr } = await command(dir, ["sort.bench.ts"], {
        startChild: failsListing,
      });

      const at = (text: string): number => stderr.indexOf(text);
      expect({
        code,
        stdout,
        stackThenOutput: at("at plum") >= 0 && at("at plum") < at("pear"),
        last: linesOf(stderr).at(-1),
      }).toStrictEqual({
        code: 2,
        stdout: "",
        stackThenOutput: true,
        last: naming("sort.bench.ts", "load", "kiwi"),
      });
    });

    it("prints no stack for a failed listing that has none", async () => {
      const dir = workspace();
      const failsListing: StartChild = async () => ({
        status: "failed",
        error: { phase: "load", message: "kiwi", stack: null },
        output: "",
      });

      const { code, stderr } = await command(dir, ["sort.bench.ts"], {
        startChild: failsListing,
      });

      expect({ code, mentionsNull: stderr.includes("null") }).toStrictEqual({
        code: 2,
        mentionsNull: false,
      });
    });
  });

  describe("on an error that is not a ConfigError", () => {
    it("rejects with that error instead of exiting 2", async () => {
      const error = new Error("kiwi");
      const findsNone: FindRuntime = async () => {
        throw error;
      };

      const ended = command(workspace(), ["sort.bench.ts"], { findRuntime: findsNone });

      await expect(ended).rejects.toBe(error);
    });
  });

  describe("--help and --version", () => {
    it("succeeds with the usage on stdout for --help", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, ["--help"], {
        startChild: startsNoChild,
      });

      expect({ code, printed: stdout.length > 0, stderr }).toStrictEqual({
        code: 0,
        printed: true,
        stderr: "",
      });
    });

    it.each([
      { why: "an unknown flag", args: ["--banana", "--help"] },
      { why: "--version", args: ["--version", "--help"] },
    ])("prints the usage beside $why, checking nothing else", async ({ args }) => {
      const dir = workspace();
      const usage = (await command(dir, ["--help"])).stdout;

      const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

      expect({ code, stdout, stderr }).toStrictEqual({ code: 0, stdout: usage, stderr: "" });
    });

    it.each([{ why: "beside an unknown flag", args: ["--banana", "--version"] }])(
      "prints the package's version on stdout for --version $why",
      async ({ args }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

        expect({ code, version: stdout.includes(String(VERSION)), stderr }).toStrictEqual({
          code: 0,
          version: true,
          stderr: "",
        });
      },
    );

    it("takes --version after a -- terminator as a benchmark file, exiting 2 naming it", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, ["--", "--version"], {
        startChild: startsNoChild,
      });

      expect({ code, stdout, stderr }).toStrictEqual({
        code: 2,
        stdout: "",
        stderr: expect.stringContaining("--version"),
      });
    });
  });

  describe("--list", () => {
    it("prints each selected case id once, in selection order, running no case", async () => {
      const dir = workspace();

      const ended = await command(
        dir,
        ["--list", "--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts"],
        { startChild: startsNoCase },
      );

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "sort/fast\nparse/fast\n",
      });
    });

    it("lists the cases of the files the default include pattern matches, in path order, when no file is given", async () => {
      const dir = workspace();

      const ended = await command(dir, ["--list"], { startChild: startsNoCase });

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "parse/fast\nsort/fast\n",
      });
    });
  });

  describe("a run", () => {
    it("prints the table on stdout once, when the run ends", async () => {
      const dir = workspace();
      const stdout = captured();
      const printedDuringRun: string[] = [];
      const watchesStdout = starter((request, runtime, options) => {
        printedDuringRun.push(stdout.text);
        return measuresAll(runtime, request, options);
      });

      await command(dir, ["sort.bench.ts", "parse.bench.ts", "--out", "report.json"], {
        stdout,
        startChild: watchesStdout,
      });

      expect({ printedDuringRun, stdout: stdout.text }).toStrictEqual({
        printedDuringRun: ["", ""],
        stdout: formatTable(reportAt(join(dir, "report.json")).results),
      });
    });

    it("prints a progress line on stderr as each child starts, naming its file or its runtime and case", async () => {
      const dir = workspace();

      const { stderr } = await command(dir, [
        "--runtime",
        "bun,node",
        "sort.bench.ts",
        "parse.bench.ts",
      ]);

      const lines = linesOf(stderr);
      expect({ listing: lines.slice(0, -4), measuring: lines.slice(-4) }).toStrictEqual({
        listing: expect.arrayContaining([naming("sort.bench.ts"), naming("parse.bench.ts")]),
        measuring: [
          naming("bun", "sort/fast"),
          naming("bun", "parse/fast"),
          naming("node", "sort/fast"),
          naming("node", "parse/fast"),
        ],
      });
    });
  });

  describe("the REPSET_CALLS_PER_SAMPLE variable", () => {
    const NAME = "REPSET_CALLS_PER_SAMPLE";
    const MAX = Number.MAX_SAFE_INTEGER;

    it.each([
      { why: "unset", value: undefined, asked: [undefined, undefined] },
      { why: "set to a count", value: "7", asked: [7, 7] },
      { why: "set to the largest safe integer", value: String(MAX), asked: [MAX, MAX] },
    ])("asks each measuring child of a run for its count when $why", async ({ value, asked }) => {
      vi.stubEnv(NAME, value);
      const counts: (number | undefined)[] = [];
      const keepsCount = starter((request, runtime, options) => {
        if (request.mode === "measure") counts.push(request.callsPerSample);
        return measuresAll(runtime, request, options);
      });

      const { code } = await command(workspace(), ["sort.bench.ts", "parse.bench.ts"], {
        startChild: keepsCount,
      });

      expect({ code, counts }).toStrictEqual({ code: 0, counts: asked });
    });

    it.each([
      { why: "the empty string", value: "" },
      { why: "zero", value: "0" },
      { why: "an exponent", value: "1e3" },
      { why: "a count past the safe integers", value: String(MAX + 1) },
    ])(
      "exits 2 on $why, naming the variable and the value on stderr, with no child",
      async ({ value }) => {
        vi.stubEnv(NAME, value);

        const { code, stdout, stderr } = await command(workspace(), ["sort.bench.ts"], {
          startChild: startsNoChild,
        });

        expect({
          code,
          stdout,
          named: stderr.includes(NAME) && stderr.includes(value),
        }).toStrictEqual({ code: 2, stdout: "", named: true });
      },
    );

    it.each([{ flag: "--help" }, { flag: "--version" }])(
      "leaves $flag as it is unset when it holds a bad value",
      async ({ flag }) => {
        const dir = workspace();
        vi.stubEnv(NAME, undefined);
        const unset = await command(dir, [flag]);
        vi.stubEnv(NAME, "abc");

        const ended = await command(dir, [flag], { startChild: startsNoChild });

        expect(ended).toStrictEqual(unset);
      },
    );
  });

  describe("--out <file>", () => {
    it("writes the report once listing passed and again after every result", async () => {
      const dir = workspace();
      const report = join(dir, "report.json");
      const writtenAtStart: number[] = [];
      const readsReport = starter((request, runtime, options) => {
        writtenAtStart.push(reportAt(report).results.length);
        return measuresAll(runtime, request, options);
      });

      await command(
        dir,
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--out", "report.json"],
        { startChild: readsReport },
      );

      expect({ writtenAtStart, atEnd: reportAt(report).results.length }).toStrictEqual({
        writtenAtStart: [0, 1, 2, 3],
        atEnd: 4,
      });
    });

    it("exits 2 with no case run, leaving no temporary file, when the first write fails", async () => {
      const dir = workspace();
      blockWrites(join(dir, "out/report.json"));

      const { code } = await command(dir, ["sort.bench.ts", "--out", "out/report.json"], {
        startChild: startsNoCase,
      });

      expect({ code, left: readdirSync(join(dir, "out")) }).toStrictEqual({
        code: 2,
        left: ["report.json"],
      });
    });

    /** Runs four children, blocking the report's write during the second and repairing it during the third. */
    async function runWithOneFailedWrite(): Promise<{
      dir: string;
      code: number;
      stderr: string;
      writtenAtLastStart: number;
      results: number;
    }> {
      const dir = workspace();
      const report = join(dir, "out/report.json");
      let started = 0;
      let writtenAtLastStart = 0;
      const failsOneWrite = starter((request, runtime, options) => {
        started += 1;
        if (started === 2) blockWrites(report);
        if (started === 3) unblockWrites(report);
        if (started === 4) writtenAtLastStart = reportAt(report).results.length;
        return measuresAll(runtime, request, options);
      });

      const { code, stderr } = await command(
        dir,
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--out", "out/report.json"],
        { startChild: failsOneWrite },
      );

      return { dir, code, stderr, writtenAtLastStart, results: reportAt(report).results.length };
    }

    it("keeps running past a failed write", async () => {
      const { code, writtenAtLastStart, results } = await runWithOneFailedWrite();

      expect({ code, writtenAtLastStart, results }).toStrictEqual({
        code: 0,
        writtenAtLastStart: 3,
        results: 4,
      });
    });

    it("says nothing when a later write repairs a failed one", async () => {
      const { dir, stderr } = await runWithOneFailedWrite();

      expect({
        mentioned: stderr.includes("report.json"),
        left: readdirSync(join(dir, "out")),
      }).toStrictEqual({ mentioned: false, left: ["report.json"] });
    });

    it("exits 1 reporting a failed last write on stderr, leaving no temporary file", async () => {
      const dir = workspace();
      const report = join(dir, "out/report.json");
      const blocksLastWrites = starter((request, runtime, options) => {
        if (request.id === "parse/fast") blockWrites(report);
        return measuresAll(runtime, request, options);
      });

      const { code, stderr } = await command(
        dir,
        ["sort.bench.ts", "parse.bench.ts", "--out", "out/report.json"],
        { startChild: blocksLastWrites },
      );

      expect({
        code,
        mentioned: stderr.includes("report.json"),
        left: readdirSync(join(dir, "out")),
      }).toStrictEqual({ code: 1, mentioned: true, left: ["report.json"] });
    });
  });

  describe("--out -", () => {
    it("prints the report on stdout", async () => {
      const dir = workspace();

      const { code, stdout } = await command(dir, [
        "sort.bench.ts",
        "parse.bench.ts",
        "--out",
        "-",
      ]);

      expect({ code, results: parseReport(stdout, "stdout").results.length }).toStrictEqual({
        code: 0,
        results: 2,
      });
    });

    it("prints the table on stderr", async () => {
      const dir = workspace();

      const { stdout, stderr } = await command(dir, [
        "sort.bench.ts",
        "parse.bench.ts",
        "--out",
        "-",
      ]);

      expect(stderr.endsWith(formatTable(parseReport(stdout, "stdout").results))).toBe(true);
    });
  });

  describe("--metric-lines", () => {
    /** Runs a failing-case run with --metric-lines, noting what stdout held as each child started. */
    async function runMetricLines(): Promise<{
      code: number;
      stdout: string;
      stderr: string;
      printedAtStart: string[];
      results: Report["results"];
    }> {
      const dir = workspace();
      const stdout = captured();
      const printedAtStart: string[] = [];
      const watchesStdout = starter((request, runtime, options) => {
        printedAtStart.push(stdout.text);
        return failsParse(runtime, request, options);
      });

      const { code, stderr } = await command(
        dir,
        ["sort.bench.ts", "parse.bench.ts", "--metric-lines", "--out", "report.json"],
        { stdout, startChild: watchesStdout },
      );

      const results = reportAt(join(dir, "report.json")).results;
      return { code, stdout: stdout.text, stderr, printedAtStart, results };
    }

    it("prints each measured result's metric line on stdout as it finishes", async () => {
      const { code, stdout, printedAtStart, results } = await runMetricLines();

      const metricText = results
        .map((result) => metricLine(result))
        .filter((line) => line !== undefined)
        .map((line) => `${line}\n`)
        .join("");
      expect({ code, printedAtStart, stdout }).toStrictEqual({
        code: 1,
        printedAtStart: ["", metricText],
        stdout: metricText,
      });
    });

    it("prints the table on stderr", async () => {
      const { stderr, results } = await runMetricLines();

      expect(stderr.endsWith(formatTable(results))).toBe(true);
    });
  });

  describe("--once", () => {
    it("prints one line per case per runtime, naming a failure's phase and message, exiting 1", async () => {
      const dir = workspace();

      const { code, stdout } = await command(
        dir,
        ["--once", "--runtime", "bun,node", "sort.bench.ts", "parse.bench.ts"],
        { startChild: failsParse },
      );

      expect({ code, lines: linesOf(stdout) }).toStrictEqual({
        code: 1,
        lines: [
          naming("bun", "sort/fast"),
          naming("bun", "parse/fast", "fn", "kiwi"),
          naming("node", "sort/fast"),
          naming("node", "parse/fast", "fn", "kiwi"),
        ],
      });
    });

    it("prints an ok line per case per runtime and exits 0 when every case passes", async () => {
      const dir = workspace();

      const { code, stdout } = await command(dir, [
        "--once",
        "--runtime",
        "bun,node",
        "sort.bench.ts",
        "parse.bench.ts",
      ]);

      expect({ code, lines: linesOf(stdout) }).toStrictEqual({
        code: 0,
        lines: [
          naming("ok", "bun", "sort/fast"),
          naming("ok", "bun", "parse/fast"),
          naming("ok", "node", "sort/fast"),
          naming("ok", "node", "parse/fast"),
        ],
      });
    });
  });

  describe("on an interrupt", () => {
    it.each([
      { signal: "SIGINT", code: 130 },
      { signal: "SIGTERM", code: 143 },
    ])(
      "exits $code on $signal after a failed case, with the finished results in the report and table",
      async ({ signal, code }) => {
        const dir = workspace();
        const signals = new EventEmitter();
        const failsThenStops = starter((request) => {
          if (request.id === "sort/fast") return failedOutcome("fn", "kiwi");
          signals.emit(signal);
          return stopped;
        });

        const ended = await command(
          dir,
          ["sort.bench.ts", "parse.bench.ts", "--out", "report.json"],
          { signals, startChild: failsThenStops },
        );

        const report = reportAt(join(dir, "report.json"));
        expect({
          code: ended.code,
          interrupted: report.interrupted,
          ran: report.results.map((result) => result.id),
          stdout: ended.stdout,
        }).toStrictEqual({
          code,
          interrupted: true,
          ran: ["sort/fast"],
          stdout: formatTable(report.results),
        });
      },
    );

    it("writes an interrupted report with no result when the signal comes during listing", async () => {
      const dir = workspace();
      const signals = new EventEmitter();
      const stopsListing: StartChild = async () => {
        signals.emit("SIGINT");
        return stopped;
      };

      const { code } = await command(dir, ["sort.bench.ts", "--out", "report.json"], {
        signals,
        startChild: stopsListing,
      });

      const report = reportAt(join(dir, "report.json"));
      expect({ code, interrupted: report.interrupted, results: report.results }).toStrictEqual({
        code: 130,
        interrupted: true,
        results: [],
      });
    });

    it("keeps the signal's exit code, reporting a failed write on stderr", async () => {
      const dir = workspace();
      const signals = new EventEmitter();
      const report = join(dir, "out/report.json");
      const blocksThenStops = starter(() => {
        blockWrites(report);
        signals.emit("SIGINT");
        return stopped;
      });

      const { code, stderr } = await command(dir, ["sort.bench.ts", "--out", "out/report.json"], {
        signals,
        startChild: blocksThenStops,
      });

      expect({ code, mentioned: stderr.includes("report.json") }).toStrictEqual({
        code: 130,
        mentioned: true,
      });
    });

    it.each([{ flag: "--list", signal: "SIGINT", code: 130, stopsIn: "list" }])(
      "exits $code on $signal in a $flag run",
      async ({ flag, signal, code, stopsIn }) => {
        const dir = workspace();
        const signals = new EventEmitter();
        const stops: StartChild = async (runtime, request, options) => {
          if (request.mode !== stopsIn) return measuresAll(runtime, request, options);
          signals.emit(signal);
          return stopped;
        };

        const ended = await command(dir, [flag, "sort.bench.ts"], { signals, startChild: stops });

        expect(ended.code).toBe(code);
      },
    );
  });
});
