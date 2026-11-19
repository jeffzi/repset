/**
 * The `repset` command: reads the command line, runs, lists or runs once the selected cases, and
 * prints what a person or a tool reads, returning the exit code.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import { styleText } from "node:util";

import { CommanderError } from "commander";

import { findRuntime as realFindRuntime, startChild as realStartChild } from "./children.js";
import {
  type Command,
  commandLine,
  noColorGiven,
  OUT_STDOUT,
  parseCommand,
  REPOSITORY,
} from "./command-line.js";
import { ConfigError, failedWith, resolveOptions } from "./options.js";
import { progressOn, type Progress } from "./progress.js";
import type { Report, Result } from "./report.js";
import {
  type ChildFunctionOverrides,
  type ChildFunctions,
  ListingError,
  type OnceInput,
  packageVersion,
  run,
  type RunInput,
  runOnce,
  selectCases,
  shownPath,
} from "./run.js";
import { failureLines, formatTable, metricLine, paint } from "./table.js";
import { thrownMessage } from "./utils.js";

/** Where the command prints: `process.stdout` and `process.stderr` fit. */
export interface Output {
  /**
   * Writes `text`; a write that fails reports its error to `done`, and a stream may report it
   * again afterwards as an `error` event.
   *
   * @param text - The text to write.
   * @param done - Called once the write is done, with the error when it failed.
   * @returns Whatever the stream returns, such as Node's `false` when it wants a pause; the
   *   command ignores it.
   */
  write(text: string, done?: (error?: Error | null) => void): unknown;
  /** Whether the stream is a terminal, which shows color unless the environment turns it off. */
  readonly isTTY?: boolean | undefined;
  /** The bits per color the terminal shows; read from the environment when absent. */
  getColorDepth?(): number;
  /** The terminal's width in columns, which the live progress line is cut to; uncut when absent. */
  readonly columns?: number | undefined;
}

/** The signals that interrupt a run. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Signal = (typeof SIGNALS)[number];

/** What delivers the interrupting signals: `process` fits. */
export interface SignalSource {
  on(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

/** The stream the command's output goes to: `process.stdout` fits. */
export interface Stdout extends Output {
  /**
   * Listens for the error a failed write reports after it returns, such as `EPIPE` once the
   * reader went away.
   *
   * @param event - The `error` event.
   * @param listener - Called with the error.
   * @returns Whatever the stream returns; the command ignores it.
   */
  on(event: "error", listener: (error: Error) => void): unknown;
  /**
   * Stops listening for the error a failed write reports.
   *
   * @param event - The `error` event.
   * @param listener - The listener {@link Stdout.on} added.
   * @returns Whatever the stream returns; the command ignores it.
   */
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** What the command reads from and prints to, and the functions it starts children with. */
export interface CommandIo extends ChildFunctionOverrides {
  /** The directory positional files, `--out` and `--config` are relative to; `process.cwd()` by default. */
  readonly cwd?: string | undefined;
  readonly stdout?: Stdout | undefined;
  readonly stderr?: Output | undefined;
  readonly signals?: SignalSource | undefined;
}

/** Where a crash's issue link opens a new issue, its body following. */
const NEW_ISSUE = `${REPOSITORY}/issues/new?body=`;

/** The longest crash issue link, short enough for browsers and GitHub to open. */
const MAX_ISSUE_LINK = 6000;

/** Whether each stream the command prints to shows color. */
export interface Colors {
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
  readonly progress: Progress;
}

// ---------------------------------------------------------------------------
// Color and errors
// ---------------------------------------------------------------------------

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
 * Judges each stream on its own: it shows color when it would by `styleText`'s rules and the
 * command line does not give `--no-color`.
 *
 * @param args - The command's arguments.
 * @param stdout - The stream the command's output goes to.
 * @param stderr - The stream the command's progress and errors go to.
 * @returns Whether each stream shows color.
 */
export function streamColors(args: readonly string[], stdout: Output, stderr: Output): Colors {
  const noColor = noColorGiven(args);
  return { stdout: !noColor && showsColor(stdout), stderr: !noColor && showsColor(stderr) };
}

/** An error line: `message` behind a `repset:` prefix, red when `color` holds. */
function errorLine(message: string, color: boolean): string {
  return `${paint("red", "repset:", color)} ${message}\n`;
}

// ---------------------------------------------------------------------------
// Child functions
// ---------------------------------------------------------------------------

/** A child starter that shows each child on the progress before it starts it. */
function announcing(context: Context): typeof realStartChild {
  const { cwd, progress, startChild } = context;
  return async (runtime, request, options) => {
    if (request.mode === "list") {
      progress.starting(`listing ${shownPath(cwd, request.file)}`);
    } else {
      const verb = request.mode === "once" ? "running" : "measuring";
      progress.starting(`${verb} ${request.id} on ${runtime.runtime}`);
    }
    return startChild(runtime, request, options);
  };
}

/** What a run, a once run and a selection take from the context alike. */
function childInput(
  context: Context,
): Pick<OnceInput, "cwd" | "signal" | "findRuntime" | "startChild" | "onPlanned"> {
  return {
    cwd: context.cwd,
    signal: context.signal,
    findRuntime: context.findRuntime,
    startChild: announcing(context),
    onPlanned: (total) => {
      context.progress.planned(total);
    },
  };
}

// ---------------------------------------------------------------------------
// Report file
// ---------------------------------------------------------------------------

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

/**
 * Writes `report` to `path` as {@link writeReport} does, turning any failure into the error the
 * command prints.
 *
 * @param path - The report file, as an absolute path.
 * @param shown - The report file as error messages show it.
 * @param report - The report to write.
 * @throws {ConfigError} When creating the directory or writing or renaming the file fails, its
 *   message naming `shown` and the failure.
 */
function writeReportOrFail(path: string, shown: string, report: Report): void {
  try {
    writeReport(path, report);
  } catch (error) {
    throw failedWith(`cannot write the report to ${shown}`, error);
  }
}

/**
 * The callbacks that write the report while the run goes on, when `--out` names a file.
 *
 * @param path - The report file, as an absolute path.
 * @param shown - The report file as error messages show it.
 * @returns `onSelected`, which writes the report's head and throws when that write fails, and
 *   `onResult`, which rewrites the report with each new result once `onSelected` ran and ignores
 *   a failed write: the caller writes the report once more when the run ends, which repairs the
 *   file or reports the failure.
 * @throws {ConfigError} From `onSelected`, when writing the report's head fails.
 */
function reportWrites(path: string, shown: string): Pick<RunInput, "onSelected" | "onResult"> {
  let current: Report | undefined;
  return {
    onSelected: (head) => {
      current = head;
      writeReportOrFail(path, shown, head);
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
  const { stdout, stderr, progress } = context;
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
      if (line !== undefined) progress.above(stdout, `${line}\n`);
      writes?.onResult?.(result);
    },
  });
  progress.stop();
  const tableTo = toStdout || command.metricLines ? "stderr" : "stdout";
  context[tableTo].write(formatTable(report.results, { color: context.colors[tableTo] }));
  if (toStdout) stdout.write(reportText(report));
  let written = true;
  if (file !== undefined) {
    try {
      writeReportOrFail(file.path, file.name, report);
    } catch (error) {
      stderr.write(errorLine(thrownMessage(error), context.colors.stderr));
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
  context.progress.stop();
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
  context.progress.stop();
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

/** Stdout as the command writes to it, and what it learned of stdout's failure. */
interface GuardedStdout {
  /** Writes to stdout until a write fails, then drops every write. */
  readonly output: Output;
  /** Resolves once every write made so far is done. */
  settled(): Promise<void>;
  /** The first error a write to stdout failed with, or `undefined` when none failed. */
  failure(): Error | undefined;
  /** Stops listening for stdout's errors, unless one arrived. */
  release(): void;
}

/**
 * Watches `stdout` for a failed write, which Node reports after the write returns: to the
 * write's callback, then as an `error` event.
 *
 * @param stdout - The stream the command's output goes to.
 * @param onFailure - Called once, with the first error a write failed with.
 * @returns The output to write to in place of `stdout`, and what it learned of stdout's failure.
 */
function guardStdout(stdout: Stdout, onFailure: (error: Error) => void): GuardedStdout {
  let failure: Error | undefined;
  let pending = Promise.resolve();
  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    onFailure(error);
  };
  stdout.on("error", fail);
  return {
    output: {
      write: (text) => {
        if (failure !== undefined) return false;
        pending = new Promise((done) => {
          stdout.write(text, (error) => {
            if (error !== undefined && error !== null) fail(error);
            done();
          });
        });
        return true;
      },
    },
    settled: async () => pending,
    failure: () => failure,
    release: () => {
      // A failed stream emits its error after the write's callback ran, so the listener stays to
      // take it: an error event with no listener crashes the process.
      if (failure === undefined) stdout.off("error", fail);
    },
  };
}

/** What stopped the command first: a signal, or a write to stdout that failed. */
type Stop = { readonly signal: Signal } | { readonly error: Error };

/** Whether `error` says the reader of the stream went away. */
function closedPipe(error: Error): boolean {
  return "code" in error && error.code === "EPIPE";
}

/**
 * The code the command exits with, as a shell reports a process that `stop` ended.
 *
 * @param stop - What stopped the command first, or `undefined` when nothing did.
 * @param code - The code the command would exit with had nothing stopped it.
 * @returns `code` when nothing stopped the command, 128 plus the number of the signal that did,
 *   128 plus `SIGPIPE`'s number when stdout's reader went away, and 1 when a write to stdout
 *   failed otherwise.
 */
function stoppedCode(stop: Stop | undefined, code: number): number {
  if (stop === undefined) return code;
  if ("signal" in stop) return 128 + constants.signals[stop.signal];
  return closedPipe(stop.error) ? 128 + constants.signals.SIGPIPE : 1;
}

/**
 * Reads the command line and runs what it asks for.
 *
 * @param args - The command's arguments, without the runtime and the script.
 * @param context - The streams, the working directory, the stop signal and the child functions.
 * @returns The action's code, 0 when `--help` or `--version` printed, and 2 when the command
 *   line, the config or the selection is wrong, which it prints.
 * @throws {Error} An error that is not a {@link ConfigError}, such as one reading the package's
 *   `package.json`.
 */
async function perform(args: readonly string[], context: Context): Promise<number> {
  try {
    const parser = commandLine(await packageVersion(), context.stdout, context.colors);
    const command = parseCommand(args, parser);
    const actions = { run: measure, list, once };
    return await actions[command.mode](command, context);
  } catch (error) {
    context.progress.stop();
    // Commander ends a run that printed the help or the version with an error of exit code 0.
    if (error instanceof CommanderError) return 0;
    if (!(error instanceof ConfigError)) throw error;
    printError(context.stderr, error, context.colors.stderr);
    return 2;
  }
}

/**
 * Runs the `repset` command. It sets no `process.exitCode` and never exits the process, so the
 * caller decides when to end it and stdout drains first.
 *
 * A signal or a failed write to stdout stops the run: the running child is killed, no other case
 * starts, nothing more goes to stdout, and the report file still gets the finished results.
 *
 * @param args - The command's arguments, without the runtime and the script.
 * @param io - The working directory, the streams, the signal source and the child functions; the
 *   process's own by default.
 * @returns 0 when every selected case ran or `--help` or `--version` printed, 1 when one failed,
 *   the last report write failed or a write to stdout failed with an error other than `EPIPE`, 2
 *   when the command line, the config or the selection is wrong, 130, 143 or 129 when `SIGINT`,
 *   `SIGTERM` or `SIGHUP` interrupted it, and 141 when stdout's reader went away. The first of a
 *   signal and a failed write to stdout sets the code, even when a wrong selection or config
 *   follows it.
 * @throws {Error} An error that is not a {@link ConfigError}, such as one reading the package's
 *   `package.json`.
 */
export async function main(args: readonly string[], io: CommandIo = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const rawStdout = io.stdout ?? process.stdout;
  // Judged before the command line is checked, so a usage error honors --no-color too.
  const colors = streamColors(args, rawStdout, stderr);
  const progress = progressOn(stderr, colors.stderr);
  const controller = new AbortController();
  let stop: Stop | undefined;
  const stopWith = (cause: Stop): void => {
    stop ??= cause;
    controller.abort();
  };
  const listeners = SIGNALS.map((signal) => {
    const listener = (): void => {
      stopWith({ signal });
    };
    return [signal, listener] as const;
  });
  const signals = io.signals ?? process;
  for (const [signal, listener] of listeners) signals.on(signal, listener);
  const stdout = guardStdout(rawStdout, (error) => {
    stopWith({ error });
  });
  let code: number;
  try {
    code = await perform(args, {
      cwd: io.cwd ?? process.cwd(),
      stdout: stdout.output,
      stderr,
      colors,
      signal: controller.signal,
      progress,
      findRuntime: io.findRuntime ?? realFindRuntime,
      startChild: io.startChild ?? realStartChild,
    });
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
    // Even on a crash: a write still in flight may yet fail, and its error needs the listener.
    await stdout.settled();
    stdout.release();
  }
  const failure = stdout.failure();
  if (failure !== undefined && !closedPipe(failure)) {
    const named = "code" in failure ? String(failure.code) : failure.message;
    stderr.write(errorLine(`cannot write to stdout: ${named}`, colors.stderr));
  }
  return stoppedCode(stop, code);
}
