/**
 * The `repset` command: reads the command line, runs, lists or runs once the selected cases, and
 * prints what a person or a tool reads, returning the exit code.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { findRuntime as realFindRuntime, startChild as realStartChild } from "./children.js";
import type { Runtime } from "./measure/runtime.js";
import { ConfigError, isRuntime, type OptionsInput, resolveOptions } from "./options.js";
import type { Report, Result } from "./report.js";
import {
  ListingError,
  packageVersion,
  run,
  type RunInput,
  runOnce,
  selectCases,
  type SelectInput,
} from "./run.js";
import { formatTable, metricLine } from "./table.js";
import { thrownMessage } from "./utils.js";

/** Where the command prints: `process.stdout` and `process.stderr` fit. */
export interface Output {
  write(text: string): unknown;
}

/** The signals that interrupt a run. */
type Signal = "SIGINT" | "SIGTERM";

/** What delivers the interrupting signals: `process` fits. */
export interface SignalSource {
  on(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

/** What the command reads from and prints to, and the functions it starts children with. */
export interface CommandIo {
  /** The directory positional files, `--out` and `--config` are relative to; `process.cwd()` by default. */
  readonly cwd?: string | undefined;
  readonly stdout?: Output | undefined;
  readonly stderr?: Output | undefined;
  readonly signals?: SignalSource | undefined;
  readonly findRuntime?: typeof realFindRuntime | undefined;
  readonly startChild?: typeof realStartChild | undefined;
}

/** The exit code of a run interrupted by each signal: 128 plus the signal's number. */
const SIGNAL_CODES: Readonly<Record<Signal, number>> = { SIGINT: 130, SIGTERM: 143 };

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

const EXCLUSIVE: readonly (readonly [string, string])[] = [
  ["list", "once"],
  ["list", "out"],
  ["list", "metric-lines"],
  ["once", "out"],
  ["once", "metric-lines"],
];

/** Decimal digits with an optional fraction: `Number` alone reads `""` as 0 and accepts `1e3`. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

const USAGE = `Usage: repset [options] [file...]

Measures the benchmark cases in the given files, or in the files the config's include matches.

Options:
  --filter <regex>        Run only the cases whose id matches the expression
  --runtime <list>        Comma-separated runtimes, run in the order given: node, bun
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

interface Command {
  readonly mode: "run" | "list" | "once";
  readonly input: Omit<OptionsInput, "cwd"> & { readonly files: readonly string[] | undefined };
  /** The `--out` value as written: a file relative to the working directory, or `-` for stdout. */
  readonly out: string | undefined;
  readonly metricLines: boolean;
}

/** The command's streams, working directory, stop signal and child functions, defaults applied. */
interface Context {
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly signal: AbortSignal;
  readonly findRuntime: typeof realFindRuntime;
  readonly startChild: typeof realStartChild;
}

/** Whether `flag` is among the arguments before a `--` terminator. */
function flagged(args: readonly string[], flag: string): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes(flag);
}

/** The value of a number flag, or `undefined` when it is absent. */
function decimal(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!DECIMAL.test(text)) {
    throw new ConfigError(`--${flag} must be a decimal number, got ${JSON.stringify(text)}`);
  }
  return Number(text);
}

/** The runtimes of a `--runtime` list, or `undefined` when it is absent. */
function runtimeList(text: string | undefined): Runtime[] | undefined {
  if (text === undefined) return undefined;
  const names = text.split(",");
  const runtimes = names.filter((name) => isRuntime(name));
  if (runtimes.length !== names.length) {
    throw new ConfigError(`--runtime must list "node" and "bun", got ${JSON.stringify(text)}`);
  }
  return runtimes;
}

/**
 * Reads the command line, past `--help` and `--version`.
 *
 * @param args - The command's arguments.
 * @returns What the command line asks for.
 * @throws {ConfigError} When a flag is unknown, given twice, missing its value or holding a value
 *   that is not a decimal number where one is due, or when two flags conflict.
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
  if (values["metric-lines"] === true && values.out === "-") {
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
  };
}

/** A child starter that prints a progress line on stderr before it starts each child. */
function announcing(context: Context): typeof realStartChild {
  const { cwd, stderr, startChild } = context;
  return async (runtime, request, options) => {
    const line =
      request.mode === "list"
        ? `listing ${relative(cwd, request.file)}`
        : `${request.mode === "once" ? "running" : "measuring"} ${request.id} on ${runtime.runtime}`;
    stderr.write(`${line}\n`);
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
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
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
        throw new ConfigError(`cannot write the report to ${shown}: ${thrownMessage(error)}`, {
          cause: error,
        });
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

/**
 * Measures the selected cases, printing the table, the metric lines and the report where the
 * flags send them.
 *
 * @param command - What the command line asks for.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns 1 when a case failed or the last write of the report failed, 0 otherwise.
 * @throws {ConfigError} When the options or the selection are wrong or the first write of the
 *   report fails, before any case runs.
 */
async function measure(command: Command, context: Context): Promise<number> {
  const { stdout, stderr } = context;
  const toFile = command.out !== undefined && command.out !== "-";
  const path = toFile ? resolve(context.cwd, command.out) : undefined;
  const writes = path === undefined ? undefined : reportWrites(path, String(command.out));
  const report = await run({
    ...command.input,
    ...childInput(context),
    onSelected: writes?.onSelected,
    onResult: (result: Result) => {
      const line = command.metricLines ? metricLine(result) : undefined;
      if (line !== undefined) stdout.write(`${line}\n`);
      writes?.onResult?.(result);
    },
  });
  const tableOut = command.out === "-" || command.metricLines ? stderr : stdout;
  tableOut.write(formatTable(report.results));
  if (command.out === "-") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  let written = true;
  if (path !== undefined) {
    try {
      writeReport(path, report);
    } catch (error) {
      stderr.write(
        `repset: cannot write the report to ${String(command.out)}: ${thrownMessage(error)}\n`,
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

/**
 * Runs every selected case once per runtime, printing a line per case and runtime.
 *
 * @param command - What the command line asks for.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns 1 when a case failed, 0 otherwise.
 * @throws {ConfigError} When the options or the selection are wrong.
 */
async function once(command: Command, context: Context): Promise<number> {
  const outcome = await runOnce({ ...command.input, ...childInput(context) });
  for (const result of outcome.results) {
    const ran = `${result.id} on ${result.runtime}`;
    context.stdout.write(
      result.status === "ok"
        ? `ok ${ran}\n`
        : `failed ${ran}: phase ${result.error.phase}: ${result.error.message}\n`,
    );
  }
  return outcome.results.some((result) => result.status === "failed") ? 1 : 0;
}

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
 *   `SIGTERM` interrupted it.
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
  const listeners = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const listener = (): void => {
      received ??= signal;
      controller.abort();
    };
    return [signal, listener] as const;
  });
  const signals = io.signals ?? process;
  for (const [signal, listener] of listeners) signals.on(signal, listener);
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
    const code = await actions[command.mode](command, context);
    return received === undefined ? code : SIGNAL_CODES[received];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    printError(stderr, error);
    return 2;
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
  }
}
