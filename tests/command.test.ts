import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

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
import { requiresRealBunHere } from "./real-bun.js";

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

/** A fresh directory named from `prefix`, removed when the test ends. */
function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
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

/** The report the file at `path` holds. */
function reportAt(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8"));
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

      expect({ code, options: reportAt(join(dir, "report.json")).options }).toStrictEqual({
        code: 0,
        options: {
          runtimes: ["bun", "node"],
          files: ["sort.bench.ts"],
          filter: "fast",
          minTime: 2.5,
          minSamples: 8,
          rounds: null,
          seed: null,
          timeout: 1234,
          nodeImport: "tsx",
          rawSamples: false,
        },
      });
    });

    it("records the files as null when no positional file is given", async () => {
      const dir = workspace();

      await command(dir, ["--out", "report.json"]);

      expect(reportAt(join(dir, "report.json")).options.files).toBeNull();
    });

    it("reads the config file --config names, relative to the working directory", async () => {
      const dir = workspace();
      writeFileSync(join(dir, "custom.mjs"), "export default { minSamples: 9 };\n");

      await command(dir, ["--config", "custom.mjs", "--out", "report.json"]);

      expect(reportAt(join(dir, "report.json")).options.minSamples).toBe(9);
    });
  });

  describe("where the command line or the config is wrong", () => {
    it.each([
      { why: "an unknown flag", args: ["--banana"] },
      { why: "a value flag given twice", args: ["--filter", "sort", "--filter", "parse"] },
      { why: "a boolean flag given twice", args: ["--once", "--once"] },
      { why: "a flag missing its value", args: ["--filter"] },
      { why: "an exponent", args: ["--min-time", "1e3"] },
      { why: "a hexadecimal number", args: ["--min-samples", "0x10"] },
      { why: "an empty number", args: ["--timeout", ""] },
      { why: "--metric-lines with --out -", args: ["--metric-lines", "--out", "-"] },
      { why: "--list with --once", args: ["--list", "--once"] },
      { why: "--list with --out", args: ["--list", "--out", "report.json"] },
      { why: "--list with --metric-lines", args: ["--list", "--metric-lines"] },
      { why: "--once with --out", args: ["--once", "--out", "report.json"] },
      { why: "--once with --metric-lines", args: ["--once", "--metric-lines"] },
      { why: "a non-decimal --min-time beside --once", args: ["--once", "--min-time", "1e3"] },
      {
        why: "an out-of-range --min-samples beside --once",
        args: ["--once", "--min-samples", "0"],
      },
      { why: "a ConfigError", args: ["--filter", "(", "--out", "report.json"] },
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

    it("accepts --min-time and --min-samples beside --once", async () => {
      const dir = workspace();

      const { code } = await command(dir, ["--once", "--min-time", "5", "--min-samples", "3"]);

      expect(code).toBe(0);
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

  describe("--help and --version", () => {
    it("prints the usage on stdout and exits 0 for --help", async () => {
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
      { why: "a flag missing its value", args: ["--help", "--filter"] },
      { why: "a conflict", args: ["--metric-lines", "--out", "-", "--help"] },
    ])("prints the usage beside $why, checking nothing else", async ({ args }) => {
      const dir = workspace();
      const usage = (await command(dir, ["--help"])).stdout;

      const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

      expect({ code, stdout, stderr }).toStrictEqual({ code: 0, stdout: usage, stderr: "" });
    });

    it.each([
      { why: "alone", args: ["--version"] },
      { why: "beside an unknown flag", args: ["--banana", "--version"] },
      { why: "beside a flag missing its value", args: ["--version", "--filter"] },
    ])(
      "prints the package's version on stdout and exits 0 for --version $why",
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
  });

  describe("--list", () => {
    it("prints each selected case id once, in selection order, and exits 0 with no case run", async () => {
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
  });

  describe("a run", () => {
    it.each([
      { why: "every case ran", startChild: measuresAll, code: 0 },
      { why: "a case failed", startChild: failsParse, code: 1 },
    ])("exits $code when $why", async ({ startChild, code }) => {
      const dir = workspace();

      const ended = await command(dir, ["sort.bench.ts", "parse.bench.ts"], { startChild });

      expect(ended.code).toBe(code);
    });

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

  describe("--out <file>", () => {
    it("writes the report relative to the working directory, indented by two spaces, ending in a newline", async () => {
      const dir = workspace();

      await command(dir, ["sort.bench.ts", "--out", "report.json"]);

      const text = readFileSync(join(dir, "report.json"), "utf8");
      expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    });

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

    it("creates the report's missing parent directories", async () => {
      const dir = workspace();

      await command(dir, ["sort.bench.ts", "--out", "deep/er/report.json"]);

      expect(reportAt(join(dir, "deep/er/report.json")).results).toHaveLength(1);
    });

    it("exits 2 with no case run when the report's directory cannot be created", async () => {
      const dir = workspace();
      writeFileSync(join(dir, "plain"), "");

      const { code, stdout } = await command(dir, ["sort.bench.ts", "--out", "plain/report.json"], {
        startChild: startsNoCase,
      });

      expect({ code, stdout }).toStrictEqual({ code: 2, stdout: "" });
    });

    it("exits 2 with no case run and leaves no temporary file when the first write fails", async () => {
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

    it("keeps running past a failed write and says nothing when a later write repairs it", async () => {
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

      expect({
        code,
        writtenAtLastStart,
        results: reportAt(report).results.length,
        mentioned: stderr.includes("report.json"),
        left: readdirSync(join(dir, "out")),
      }).toStrictEqual({
        code: 0,
        writtenAtLastStart: 3,
        results: 4,
        mentioned: false,
        left: ["report.json"],
      });
    });

    it("reports a failed last write on stderr and exits 1, leaving no temporary file", async () => {
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
    it("prints the report on stdout and the table on stderr", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, [
        "sort.bench.ts",
        "parse.bench.ts",
        "--out",
        "-",
      ]);

      const report: Report = JSON.parse(stdout);
      expect({
        code,
        results: report.results.length,
        table: stderr.endsWith(formatTable(report.results)),
      }).toStrictEqual({
        code: 0,
        results: 2,
        table: true,
      });
    });
  });

  describe("--metric-lines", () => {
    it("prints each measured result's metric line on stdout as it finishes and the table on stderr", async () => {
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
      const metricText = results
        .map((result) => metricLine(result))
        .filter((line) => line !== undefined)
        .map((line) => `${line}\n`)
        .join("");
      expect({
        code,
        printedAtStart,
        stdout: stdout.text,
        table: stderr.endsWith(formatTable(results)),
      }).toStrictEqual({
        code: 1,
        printedAtStart: ["", metricText],
        stdout: metricText,
        table: true,
      });
    });
  });

  describe("--once", () => {
    it("prints one line per case and runtime, with a failure's phase and message, and exits 1", async () => {
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

    it("reports a failed write on stderr and keeps the signal's exit code", async () => {
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

    it.each([
      { flag: "--list", signal: "SIGINT", code: 130, stopsIn: "list" },
      { flag: "--once", signal: "SIGTERM", code: 143, stopsIn: "once" },
    ])("exits $code on $signal in a $flag run", async ({ flag, signal, code, stopsIn }) => {
      const dir = workspace();
      const signals = new EventEmitter();
      const stops: StartChild = async (runtime, request, options) => {
        if (request.mode !== stopsIn) return measuresAll(runtime, request, options);
        signals.emit(signal);
        return stopped;
      };

      const ended = await command(dir, [flag, "sort.bench.ts"], { signals, startChild: stops });

      expect(ended.code).toBe(code);
    });
  });
});

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Node, tsx and the measuring children starting, then short measurements, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** Windows has no signal a process can be sent and handle. */
const POSIX = process.platform !== "win32";

/** The fixture `name`, relative to the repository root the command starts in. */
function commandFixture(name: string): string {
  return `tests/fixtures/command/${name}`;
}

/**
 * Starts the command from source on Node in the repository root.
 *
 * @param args - The command's arguments.
 * @param onStderr - Receives the command's stderr so far each time it grows, and a function that
 *   sends the command a signal the first time it is called.
 * @returns The exit code, or `null` when a signal ended the command, and what it printed.
 */
async function spawnCommand(
  args: readonly string[],
  onStderr: (stderr: string, stop: (signal: NodeJS.Signals) => void) => void = () => {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stopSent = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onStderr(stderr, (signal) => {
      if (!stopSent) child.kill(signal);
      stopSent = true;
    });
  });
  const [code]: unknown[] = await once(child, "close");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
}

/** A fresh directory for a spawned command's report, removed when the test ends. */
function reportDir(): string {
  return temporaryDir("repset-command-e2e-");
}

describe("the command started as a process", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe.each([
    { runtime: "node", here: true },
    { runtime: "bun", here: requiresRealBunHere() },
  ])("on $runtime", ({ runtime, here }) => {
    it.runIf(here)(
      "prints the table, writes a schema-1 report with every case ok and exits 0",
      async () => {
        const out = join(reportDir(), "report.json");

        const { code, stdout } = await spawnCommand([
          commandFixture("sum.bench.ts"),
          "--runtime",
          runtime,
          "--node-import",
          "tsx",
          "--min-time",
          "1",
          "--out",
          out,
        ]);

        const report = reportAt(out);
        expect({
          code,
          schema: report.schema,
          ran: report.results.map((result) => [result.id, result.runtime.name, result.status]),
          stdout,
        }).toStrictEqual({
          code: 0,
          schema: 1,
          ran: [
            ["sum/small", runtime, "ok"],
            ["sum/large", runtime, "ok"],
          ],
          stdout: formatTable(report.results),
        });
      },
    );
  });

  it("exits 1 with the error in the result when a case throws", async () => {
    const out = join(reportDir(), "report.json");

    const { code } = await spawnCommand([
      commandFixture("throws.bench.ts"),
      "--node-import",
      "tsx",
      "--min-time",
      "1",
      "--out",
      out,
    ]);

    expect({
      code,
      errors: reportAt(out).results.map((result) => result.error?.message),
    }).toStrictEqual({ code: 1, errors: ["banana"] });
  });

  it("exits 2 on a bad flag", async () => {
    const { code, stdout } = await spawnCommand(["--banana"]);

    expect({ code, stdout }).toStrictEqual({ code: 2, stdout: "" });
  });

  it.runIf(POSIX)("exits 130 on SIGINT, killing the running case", async () => {
    const out = join(reportDir(), "report.json");

    const { code } = await spawnCommand(
      [
        commandFixture("sum.bench.ts"),
        "--node-import",
        "tsx",
        "--min-time",
        "600000",
        "--out",
        out,
      ],
      (stderr, stop) => {
        if (stderr.includes("sum/small")) stop("SIGINT");
      },
    );

    const report = reportAt(out);
    expect({ code, interrupted: report.interrupted, results: report.results }).toStrictEqual({
      code: 130,
      interrupted: true,
      results: [],
    });
  });
});
