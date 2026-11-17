/**
 * The `repset` command: reads the command line, runs, lists or runs once the selected cases, and
 * prints what a person or a tool reads, returning the exit code.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { findRuntime as realFindRuntime, startChild as realStartChild } from "./children.js";
import { RUNTIMES, type Runtime } from "./measure/runtime.js";
import {
  ConfigError,
  failedWith,
  isRuntime,
  type OptionsInput,
  QUOTED_RUNTIMES,
  resolveOptions,
} from "./options.js";
import type { Report, Result } from "./report.js";
import {
  type ChildFunctionOverrides,
  type ChildFunctions,
  ListingError,
  packageVersion,
  run,
  type RunInput,
  runOnce,
  selectCases,
  type SelectInput,
  shownPath,
} from "./run.js";
import { failureLines, formatTable, metricLine } from "./table.js";
import { describe, thrownMessage } from "./utils.js";

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Where the command prints: `process.stdout` and `process.stderr` fit. */
export interface Output {
  write(text: string): unknown;
}

/** The signals that interrupt a run. */
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

type Signal = (typeof SIGNALS)[number];

/** What delivers the interrupting signals: `process` fits. */
export interface SignalSource {
  on(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

/** What the command reads from and prints to, and the functions it starts children with. */
export interface CommandIo extends ChildFunctionOverrides {
  /** The directory positional files, `--out` and `--config` are relative to; `process.cwd()` by default. */
  readonly cwd?: string | undefined;
  readonly stdout?: Output | undefined;
  readonly stderr?: Output | undefined;
  readonly signals?: SignalSource | undefined;
}

const FLAGS = {
  filter: { type: "string" },
  runtime: { type: "string" },
  "min-time": { type: "string" },
  "min-samples": { type: "string" },
  timeout: { type: "string" },
  "node-import": { type: "string" },
  out: { type: "string" },
  "metric-lines": { type: "boolean" },
  list: { type: "boolean" },
  once: { type: "boolean" },
  config: { type: "string" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

type FlagName = keyof typeof FLAGS;

const EXCLUSIVE: readonly (readonly [FlagName, FlagName])[] = [
  ["list", "once"],
  ["list", "out"],
  ["list", "metric-lines"],
  ["once", "out"],
  ["once", "metric-lines"],
];

/** Decimal digits with an optional fraction: `Number` alone reads `""` as 0 and accepts `1e3`. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** The environment variable that fixes the calls per sample of every measuring child of a run. */
export const CALLS_PER_SAMPLE = "REPSET_CALLS_PER_SAMPLE";

/** The `--out` value that sends the report to stdout instead of a file. */
const OUT_STDOUT = "-";

const USAGE = `Usage: repset [options] [file...]

Measures the benchmark cases in the given files, or in the files the config's include matches.

Options:
  --filter <regex>        Run only the cases whose id matches the expression
  --runtime <list>        Comma-separated runtimes, run in the order given: ${RUNTIMES.join(", ")}
  --min-time <ms>         Timing lasts at least this long
  --min-samples <n>       Timing takes at least this many samples
  --timeout <ms>          The longest one child may run
  --node-import <module>  A module Node children import first, such as tsx
  --out <file>            Write the report there; - writes it to stdout and the table to stderr
  --metric-lines          Print one METRIC line per result on stdout and the table to stderr
  --list                  Print the selected case ids and exit
  --once                  Run every selected case once per runtime, with no timing
  --config <file>         Read this config file instead of looking for one
  --help                  Print this help
  --version               Print the version
`;

interface CommandInput extends StrictOmit<OptionsInput, "cwd"> {
  readonly files: readonly string[] | undefined;
}

interface Command {
  readonly mode: "run" | "list" | "once";
  readonly input: CommandInput;
  /** The `--out` value as written: a file relative to the working directory, or `-` for stdout. */
  readonly out: string | undefined;
  readonly metricLines: boolean;
  /** The calls per sample `REPSET_CALLS_PER_SAMPLE` fixes for a run, or `undefined` when unset. */
  readonly callsPerSample: number | undefined;
}

/** The command's streams, working directory, stop signal and child functions, defaults applied. */
interface Context extends ChildFunctions {
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Command-line parsing
// ---------------------------------------------------------------------------

/** Whether `flag` is among the arguments before a `--` terminator. */
function flagged(args: readonly string[], flag: string): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes(flag);
}

/**
 * Reads the value of a number flag.
 *
 * @param flag - The flag's name, without the leading dashes, which the error names.
 * @param text - The flag's value, or `undefined` when the flag is absent.
 * @returns The number, or `undefined` when the flag is absent.
 * @throws {@link ConfigError} When `text` is not decimal digits with an optional fraction.
 */
function decimal(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!DECIMAL.test(text)) {
    throw new ConfigError(`--${flag} must be a decimal number, got ${describe(text)}`);
  }
  return Number(text);
}

/**
 * The calls per sample the environment fixes.
 *
 * @param text - The value of `REPSET_CALLS_PER_SAMPLE`, or `undefined` when it is unset.
 * @returns The count, or `undefined` when the variable is unset, which leaves the count to each
 *   measuring child.
 * @throws {ConfigError} When the value, the empty string included, is not decimal digits naming a
 *   safe integer of 1 or more.
 */
function fixedCallsPerSample(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const count = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new ConfigError(
      `${CALLS_PER_SAMPLE} must be a whole number of 1 or more, got ${describe(text)}`,
    );
  }
  return count;
}

/**
 * Reads the runtimes of a `--runtime` list.
 *
 * @param text - The comma-separated list, or `undefined` when the flag is absent.
 * @returns The runtimes in the order given, or `undefined` when the flag is absent.
 * @throws {@link ConfigError} When an entry of the list is not a runtime.
 */
function runtimeList(text: string | undefined): Runtime[] | undefined {
  if (text === undefined) return undefined;
  const names = text.split(",");
  const runtimes = names.filter((name) => isRuntime(name));
  if (runtimes.length !== names.length) {
    throw new ConfigError(`--runtime must list ${QUOTED_RUNTIMES}, got ${describe(text)}`);
  }
  return runtimes;
}

/**
 * Reads the command line and `REPSET_CALLS_PER_SAMPLE`, past `--help` and `--version`.
 *
 * @param args - The command's arguments.
 * @returns What the command line and the environment ask for.
 * @throws {ConfigError} When a flag is unknown, given twice, missing its value or holding a value
 *   that is not a decimal number where one is due, when two flags conflict, or when
 *   `REPSET_CALLS_PER_SAMPLE` holds a bad value.
 */
function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: FLAGS, allowPositionals: true, tokens: true });
  } catch (error) {
    throw new ConfigError(thrownMessage(error), { cause: error });
  }
  const { values, positionals, tokens } = parsed;
  const given = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (given.has(token.name)) throw new ConfigError(`--${token.name} is given more than once`);
    given.add(token.name);
  }
  if (values["metric-lines"] === true && values.out === OUT_STDOUT) {
    throw new ConfigError("--metric-lines cannot be used with --out -");
  }
  const conflict = EXCLUSIVE.find(([one, other]) => given.has(one) && given.has(other));
  if (conflict !== undefined) {
    throw new ConfigError(`--${conflict[0]} cannot be used with --${conflict[1]}`);
  }
  let mode: Command["mode"] = "run";
  if (values.list === true) mode = "list";
  if (values.once === true) mode = "once";
  return {
    mode,
    input: {
      files: positionals.length > 0 ? positionals : undefined,
      filter: values.filter,
      runtimes: runtimeList(values.runtime),
      minTime: decimal("min-time", values["min-time"]),
      minSamples: decimal("min-samples", values["min-samples"]),
      timeout: decimal("timeout", values.timeout),
      nodeImport: values["node-import"],
      config: values.config,
    },
    out: values.out,
    metricLines: values["metric-lines"] === true,
    callsPerSample: fixedCallsPerSample(process.env[CALLS_PER_SAMPLE]),
  };
}

// ---------------------------------------------------------------------------
// Child functions and report output
// ---------------------------------------------------------------------------

/** A child starter that prints a progress line on stderr before it starts each child. */
function announcing(context: Context): typeof realStartChild {
  const { cwd, stderr, startChild } = context;
  return async (runtime, request, options) => {
    if (request.mode === "list") {
      stderr.write(`listing ${shownPath(cwd, request.file)}\n`);
    } else {
      const verb = request.mode === "once" ? "running" : "measuring";
      stderr.write(`${verb} ${request.id} on ${runtime.runtime}\n`);
    }
    return startChild(runtime, request, options);
  };
}

/** What a run, a once run and a selection take from the context alike. */
function childInput(
  context: Context,
): Pick<SelectInput, "cwd" | "signal" | "findRuntime" | "startChild"> {
  return {
    cwd: context.cwd,
    signal: context.signal,
    findRuntime: context.findRuntime,
    startChild: announcing(context),
  };
}

/** The report as a file or stdout holds it: JSON indented by two spaces, and a newline. */
function reportText(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Writes `report` to `path` through a temporary file in the same directory renamed over it, so
 * the file always holds a whole report, creating the directory first when it is missing.
 *
 * @param path - The report file, as an absolute path.
 * @param report - The report to write.
 * @throws {Error} The error creating the directory or writing or renaming the file; the temporary
 *   file is removed first.
 */
function writeReport(path: string, report: Report): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, reportText(report));
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The callbacks that write the report while the run goes on, when `--out` names a file. */
function reportWrites(path: string, shown: string): Pick<RunInput, "onSelected" | "onResult"> {
  let current: Report | undefined;
  return {
    onSelected: (head) => {
      current = head;
      try {
        writeReport(path, head);
      } catch (error) {
        throw failedWith(`cannot write the report to ${shown}`, error);
      }
    },
    onResult: (result) => {
      if (current === undefined) return;
      current = { ...current, results: [...current.results, result] };
      try {
        writeReport(path, current);
      } catch {
        // The run goes on: the write when the run ends either repairs the file or reports the
        // failure, so a failure here has nothing left to tell.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Measures the selected cases, printing the table, the metric lines and the report where the
 * flags send them.
 *
 * @param command - What the command line asks for.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns 1 when a case failed or the last write of the report failed, 0 otherwise.
 * @throws {ConfigError} When the options or the selection are wrong or the first write of the
 *   report fails, before any case runs.
 * @throws {Error} The error reading the package's `package.json`, before any case runs, or what
 *   starting a child throws.
 */
async function measure(command: Command, context: Context): Promise<number> {
  const { stdout, stderr } = context;
  const { out } = command;
  const toStdout = out === OUT_STDOUT;
  const file =
    out === undefined || toStdout ? undefined : { name: out, path: resolve(context.cwd, out) };
  const writes = file === undefined ? undefined : reportWrites(file.path, file.name);
  const report = await run({
    ...command.input,
    ...childInput(context),
    callsPerSample: command.callsPerSample,
    onSelected: writes?.onSelected,
    onResult: (result: Result) => {
      const line = command.metricLines ? metricLine(result) : undefined;
      if (line !== undefined) stdout.write(`${line}\n`);
      writes?.onResult?.(result);
    },
  });
  const tableOut = toStdout || command.metricLines ? stderr : stdout;
  tableOut.write(formatTable(report.results));
  if (toStdout) stdout.write(reportText(report));
  let written = true;
  if (file !== undefined) {
    try {
      writeReport(file.path, report);
    } catch (error) {
      stderr.write(
        `repset: ${failedWith(`cannot write the report to ${file.name}`, error).message}\n`,
      );
      written = false;
    }
  }
  const failed = report.results.some((result) => result.status === "failed");
  return failed || !written ? 1 : 0;
}

/**
 * Prints the selected case ids on stdout, one per line.
 *
 * @param command - What the command line asks for.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns 0.
 * @throws {ConfigError} When the options or the selection are wrong.
 * @throws {Error} What starting a listing child throws, or what finding the runtime this process
 *   runs on throws.
 */
async function list(command: Command, context: Context): Promise<number> {
  const options = await resolveOptions({ ...command.input, cwd: context.cwd });
  const selection = await selectCases({
    options,
    files: command.input.files ?? [],
    ...childInput(context),
  });
  if (selection.status === "selected") {
    context.stdout.write(selection.cases.map((selected) => `${selected.id}\n`).join(""));
  }
  return 0;
}

/** Where a once run's teardown line starts, beneath the failed line it follows. */
const ONCE_INDENT = "  ";

/**
 * Runs every selected case once per runtime, printing a line per case and runtime with each further
 * line of a failure's message beneath its first, and a labelled line beneath a failed one whose
 * cleanup teardown failed too.
 *
 * @param command - What the command line asks for.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns 1 when a case failed, 0 otherwise.
 * @throws {ConfigError} When the options or the selection are wrong.
 * @throws {Error} What starting a child throws.
 */
async function once(command: Command, context: Context): Promise<number> {
  const outcome = await runOnce({ ...command.input, ...childInput(context) });
  for (const result of outcome.results) {
    const ran = `${result.id} on ${result.runtime}`;
    if (result.status === "ok") {
      context.stdout.write(`ok ${ran}\n`);
      continue;
    }
    const lead = `failed ${ran}: phase ${result.error.phase}: `;
    context.stdout.write(
      failureLines(lead, result.error, ONCE_INDENT)
        .map((line) => `${line}\n`)
        .join(""),
    );
  }
  return outcome.results.some((result) => result.status === "failed") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Prints a `ConfigError`; a failed listing's stack and output tail come before its message. */
function printError(stderr: Output, error: ConfigError): void {
  if (error instanceof ListingError) {
    for (const text of [error.failureStack ?? "", error.output]) {
      if (text !== "") stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  }
  stderr.write(`repset: ${error.message}\n`);
}

/**
 * Runs the `repset` command. It sets no `process.exitCode` and never exits the process, so the
 * caller decides when to end it and stdout drains first.
 *
 * @param args - The command's arguments, without the runtime and the script.
 * @param io - The working directory, the streams, the signal source and the child functions; the
 *   process's own by default.
 * @returns 0 when every selected case ran, 1 when one failed or the last report write failed, 2
 *   when the command line, the config or the selection is wrong, and 130 or 143 when `SIGINT` or
 *   `SIGTERM` interrupted it, even when a wrong selection or config follows the interrupt.
 * @throws {Error} An error that is not a {@link ConfigError}, such as one reading the package's
 *   `package.json`.
 */
export async function main(args: readonly string[], io: CommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (flagged(args, "--help")) {
    stdout.write(USAGE);
    return 0;
  }
  if (flagged(args, "--version")) {
    stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  const controller = new AbortController();
  let received: Signal | undefined;
  const listeners = SIGNALS.map((signal) => {
    const listener = (): void => {
      received ??= signal;
      controller.abort();
    };
    return [signal, listener] as const;
  });
  const signals = io.signals ?? process;
  for (const [signal, listener] of listeners) signals.on(signal, listener);
  // An interrupted run exits 128 plus the signal's number, as a shell reports it, whatever the
  // command would have exited with: a ConfigError the interrupt provoked included.
  const exitCode = (code: number): number =>
    received === undefined ? code : 128 + constants.signals[received];
  try {
    const command = parseCommand(args);
    const context: Context = {
      cwd: io.cwd ?? process.cwd(),
      stdout,
      stderr,
      signal: controller.signal,
      findRuntime: io.findRuntime ?? realFindRuntime,
      startChild: io.startChild ?? realStartChild,
    };
    const actions = { run: measure, list, once };
    return exitCode(await actions[command.mode](command, context));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    printError(stderr, error);
    return exitCode(2);
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
  }
}
