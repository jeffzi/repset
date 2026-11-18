/**
 * The `repset` command: reads the command line, runs, lists or runs once the selected cases, and
 * prints what a person or a tool reads, returning the exit code.
 */
import { constants } from "node:os";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { styleText } from "node:util";

import { createHelpConfig } from "@jeffzi/epaulettes";
import { Command as Parser, CommanderError } from "commander";

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
import { reportText, reportWrites, writeReport } from "./report-output.js";
import type { Result } from "./report.js";
import {
  type ChildFunctionOverrides,
  type ChildFunctions,
  ListingError,
  packageVersion,
  run,
  runOnce,
  selectCases,
  type SelectInput,
  shownPath,
} from "./run.js";
import { failureLines, formatTable, metricLine, paint } from "./table.js";
import { describe, thrownMessage } from "./utils.js";

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Where the command prints: `process.stdout` and `process.stderr` fit. */
export interface Output {
  write(text: string): unknown;
  /** Whether the stream is a terminal, which shows color unless the environment turns it off. */
  readonly isTTY?: boolean | undefined;
  /** The bits per color the terminal shows; read from the environment when absent. */
  getColorDepth?(): number;
}

/** The signals that interrupt a run. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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

/** Flags that cannot be given together, by name without the leading dashes. */
const EXCLUSIVE: readonly (readonly [string, string])[] = [
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

/** The README's common commands; keep them in step with it. */
const EXAMPLES: readonly (readonly [string, string])[] = [
  ["repset benchmarks/sort.bench.ts", "Runs the benchmarks of that file only"],
  ["repset --filter '^sort/'", "Runs the cases whose id matches the regular expression"],
  ["repset --runtime node,bun", "Runs every case on Node, then on Bun"],
  ["repset --out report.json", "Writes the JSON report to report.json"],
  ["repset --once", "Runs every case once, without timing, to check it works"],
];

const README = "https://github.com/jeffzi/repset#readme";

/** Where a crash's issue link opens a new issue, its body following. */
const NEW_ISSUE = "https://github.com/jeffzi/repset/issues/new?body=";

/** The longest crash issue link, short enough for browsers and GitHub to open. */
const MAX_ISSUE_LINK = 6000;

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

/** Whether each stream the command prints to shows color. */
interface Colors {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/** The command's streams, working directory, stop signal and child functions, defaults applied. */
interface Context extends ChildFunctions {
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly colors: Colors;
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

/** The color depth of a terminal that reports none: one bit under `NO_COLOR` or a dumb `TERM`. */
function environmentColorDepth(): number {
  const noColor = process.env["NO_COLOR"];
  const colorOff = (noColor !== undefined && noColor !== "") || process.env["TERM"] === "dumb";
  return colorOff ? 1 : 4;
}

/**
 * Whether `output` shows color by `styleText`'s rules: `FORCE_COLOR` decides when set, otherwise a
 * terminal of more than one bit per color does. `styleText` judges only a real stream, so it judges
 * one that reports what `output` does.
 *
 * @param output - The stream the command prints to.
 * @returns Whether text styled for `output` keeps its escape codes.
 */
function showsColor(output: Output): boolean {
  const stream = Object.assign(new Writable(), {
    isTTY: output.isTTY === true,
    getColorDepth: (): number => output.getColorDepth?.() ?? environmentColorDepth(),
  });
  return styleText("red", "x", { stream }) !== "x";
}

/**
 * Judges each stream on its own: it shows color when it would by `styleText`'s rules and
 * `--no-color` is not among the arguments before a `--` terminator.
 *
 * @param args - The command's arguments.
 * @param stdout - The stream the command's output goes to.
 * @param stderr - The stream the command's progress and errors go to.
 * @returns Whether each stream shows color.
 */
export function streamColors(args: readonly string[], stdout: Output, stderr: Output): Colors {
  const noColor = flagged(args, "--no-color");
  return { stdout: !noColor && showsColor(stdout), stderr: !noColor && showsColor(stderr) };
}

/** An error line: `message` behind a `repset:` prefix, red when `color` holds. */
function errorLine(message: string, color: boolean): string {
  return `${paint("red", "repset:", color)} ${message}\n`;
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

/** The help's closing text: the examples, then where the README lives. */
function helpEpilogue(color: boolean): string {
  const width = Math.max(...EXAMPLES.map(([example]) => example.length));
  const examples = EXAMPLES.map(([example, what]) => `  ${example.padEnd(width)}  ${what}`);
  const heading = paint("bold", "Examples:", color);
  return ["", heading, ...examples, "", `Documentation: ${README}`].join("\n");
}

/**
 * Builds the command-line parser. Its help and version go to `stdout`, styled when that stream
 * shows color. It prints no error and never exits the process: it throws instead.
 *
 * @param version - The version `--version` prints.
 * @param stdout - The stream the help and the version go to.
 * @param colors - Whether each stream shows color.
 * @returns The parser, with no arguments parsed yet.
 */
function commandLine(version: string, stdout: Output, colors: Colors): Parser {
  return new Parser("repset")
    .description(
      "Measures the benchmark cases in the given files, or in the files the config's include matches.",
    )
    .argument("[file...]")
    .option("--filter <regex>", "Run only the cases whose id matches the expression")
    .option(
      "--runtime <list>",
      `Comma-separated runtimes, run in the order given: ${RUNTIMES.join(", ")}`,
    )
    .option("--min-time <ms>", "Timing lasts at least this long")
    .option("--min-samples <n>", "Timing takes at least this many samples")
    .option("--timeout <ms>", "The longest one child may run")
    .option("--node-import <module>", "A module Node children import first, such as tsx")
    .option("--out <file>", "Write the report there; - writes it to stdout and the table to stderr")
    .option("--metric-lines", "Print one METRIC line per result on stdout and the table to stderr")
    .option("--list", "Print the selected case ids and exit")
    .option("--once", "Run every selected case once per runtime, with no timing")
    .option("--config <file>", "Read this config file instead of looking for one")
    .option("--no-color", "Print no color, even on a terminal")
    .helpOption("--help", "Print this help")
    .version(version, "--version", "Print the version")
    .addHelpText("after", helpEpilogue(colors.stdout))
    .configureHelp(createHelpConfig())
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      // A usage error reaches stderr through the ConfigError the exit override throws.
      outputError: () => undefined,
      getOutHasColors: () => colors.stdout,
    })
    .exitOverride((error) => {
      if (error.exitCode === 0) throw error;
      throw new ConfigError(error.message.replace(/^error: /u, ""), { cause: error });
    });
}

/**
 * Reads the command line and `REPSET_CALLS_PER_SAMPLE`.
 *
 * @param args - The command's arguments.
 * @param parser - The parser {@link commandLine} built.
 * @returns What the command line and the environment ask for.
 * @throws {CommanderError} With exit code 0 once `--help` or `--version` printed, before any other
 *   check.
 * @throws {ConfigError} When a flag is unknown, missing its value or holding a value that is not a
 *   decimal number where one is due, when two flags conflict, or when `REPSET_CALLS_PER_SAMPLE`
 *   holds a bad value.
 */
function parseCommand(args: readonly string[], parser: Parser): Command {
  parser.parse(args, { from: "user" });
  const values = parser.opts<Record<string, unknown>>();
  const text = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const given = new Set(
    parser.options
      .filter((option) => parser.getOptionValueSource(option.attributeName()) === "cli")
      .map((option) => option.name()),
  );
  if (given.has("metric-lines") && text("out") === OUT_STDOUT) {
    throw new ConfigError("--metric-lines cannot be used with --out -");
  }
  const conflict = EXCLUSIVE.find(([one, other]) => given.has(one) && given.has(other));
  if (conflict !== undefined) {
    throw new ConfigError(`--${conflict[0]} cannot be used with --${conflict[1]}`);
  }
  let mode: Command["mode"] = "run";
  if (given.has("list")) mode = "list";
  if (given.has("once")) mode = "once";
  return {
    mode,
    input: {
      files: parser.args.length > 0 ? parser.args : undefined,
      filter: text("filter"),
      runtimes: runtimeList(text("runtime")),
      minTime: decimal("min-time", text("minTime")),
      minSamples: decimal("min-samples", text("minSamples")),
      timeout: decimal("timeout", text("timeout")),
      nodeImport: text("nodeImport"),
      config: text("config"),
    },
    out: text("out"),
    metricLines: given.has("metric-lines"),
    callsPerSample: fixedCallsPerSample(process.env[CALLS_PER_SAMPLE]),
  };
}

// ---------------------------------------------------------------------------
// Child functions
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
  const tableTo = toStdout || command.metricLines ? "stderr" : "stdout";
  context[tableTo].write(formatTable(report.results, { color: context.colors[tableTo] }));
  if (toStdout) stdout.write(reportText(report));
  let written = true;
  if (file !== undefined) {
    try {
      writeReport(file.path, report);
    } catch (error) {
      const { message } = failedWith(`cannot write the report to ${file.name}`, error);
      stderr.write(errorLine(message, context.colors.stderr));
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
  const color = context.colors.stdout;
  for (const result of outcome.results) {
    const ran = `${result.id} on ${result.runtime}`;
    if (result.status === "ok") {
      context.stdout.write(`${paint("green", "ok", color)} ${ran}\n`);
      continue;
    }
    const lead = `${paint("red", "failed", color)} ${ran}: phase ${result.error.phase}: `;
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

/**
 * Prints a `ConfigError`; a failed listing's stack and output tail come before its message.
 *
 * @param stderr - The stream the error goes to.
 * @param error - The error to print.
 * @param color - Whether `stderr` shows color.
 */
function printError(stderr: Output, error: ConfigError, color: boolean): void {
  if (error instanceof ListingError) {
    for (const text of [error.failureStack ?? "", error.output]) {
      if (text !== "") stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  }
  stderr.write(errorLine(error.message, color));
}

/** What a crash report names beside the error. */
interface CrashAbout {
  /** The package's version, or `undefined` when reading it failed. */
  readonly version: string | undefined;
  readonly os: string;
  readonly runtime: string;
  /** Whether the stream the report goes to shows color; plain when absent. */
  readonly color?: boolean | undefined;
}

/** The percent-encoded longest start of `text`, cut on a whole character, that fits in `room`. */
function encodedStart(text: string, room: number): string {
  let left = room;
  let encoded = "";
  // A whole code point at a time, each encoded alone, so the cut splits no surrogate pair and
  // no percent-escape. toWellFormed: a lone surrogate would make encodeURIComponent throw.
  for (const char of text.toWellFormed()) {
    const escaped = encodeURIComponent(char);
    if (escaped.length > left) break;
    left -= escaped.length;
    encoded += escaped;
  }
  return encoded;
}

/**
 * Builds what `repset` prints when the command fails with an error that is not a
 * {@link ConfigError}: the error's stack, then a line naming the version and the platform, ending
 * with a link that opens a GitHub issue prefilled with them and the error's message. The message
 * is cut to keep the link within {@link MAX_ISSUE_LINK} characters; the stack holds it whole.
 *
 * @param error - The thrown value.
 * @param about - The version, the OS, the runtime and whether the output shows color.
 * @returns The report's lines, each ending with a newline.
 */
export function crashReport(error: unknown, about: CrashAbout): string {
  const version = about.version ?? "unknown";
  const message = thrownMessage(error);
  const stack = (error instanceof Error ? error.stack : undefined) ?? message;
  const head = encodeURIComponent(
    `- repset: ${version}\n- OS: ${about.os}\n- Runtime: ${about.runtime}\n\n\`\`\`text\n`,
  );
  const foot = encodeURIComponent("\n```\n");
  const room = MAX_ISSUE_LINK - NEW_ISSUE.length - head.length - foot.length;
  const link = `${NEW_ISSUE}${head}${encodedStart(message, room)}${foot}`;
  const line = `version ${version} crashed on ${about.os} with ${about.runtime}; report it at ${link}`;
  return `${stack.endsWith("\n") ? stack : `${stack}\n`}${errorLine(line, about.color === true)}`;
}

/**
 * Runs the `repset` command. It sets no `process.exitCode` and never exits the process, so the
 * caller decides when to end it and stdout drains first.
 *
 * @param args - The command's arguments, without the runtime and the script.
 * @param io - The working directory, the streams, the signal source and the child functions; the
 *   process's own by default.
 * @returns 0 when every selected case ran or `--help` or `--version` printed, 1 when one failed
 *   or the last report write failed, 2 when the command line, the config or the selection is
 *   wrong, and 130, 143 or 129 when `SIGINT`, `SIGTERM` or `SIGHUP` interrupted it, even when a
 *   wrong selection or config follows the interrupt.
 * @throws {Error} An error that is not a {@link ConfigError}, such as one reading the package's
 *   `package.json`.
 */
export async function main(args: readonly string[], io: CommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  // Judged before the command line is checked, so a usage error honors --no-color too.
  const colors = streamColors(args, stdout, stderr);
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
    const parser = commandLine(await packageVersion(), stdout, colors);
    const command = parseCommand(args, parser);
    const context: Context = {
      cwd: io.cwd ?? process.cwd(),
      stdout,
      stderr,
      colors,
      signal: controller.signal,
      findRuntime: io.findRuntime ?? realFindRuntime,
      startChild: io.startChild ?? realStartChild,
    };
    const actions = { run: measure, list, once };
    return exitCode(await actions[command.mode](command, context));
  } catch (error) {
    // Commander ends a run that printed the help or the version with an error of exit code 0.
    if (error instanceof CommanderError) return exitCode(0);
    if (!(error instanceof ConfigError)) throw error;
    printError(stderr, error, colors.stderr);
    return exitCode(2);
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
  }
}
