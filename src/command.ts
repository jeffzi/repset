/**
 * The `repset` command: reads the command line, runs, lists or runs once the selected cases, and
 * prints what a person or a tool reads, returning the exit code.
 */
import { constants } from "node:os";
import { resolve } from "node:path";
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
} from "./command-line.js";
import { ConfigError, failedWith, resolveOptions } from "./options.js";
import { reportText, reportWrites, writeReport } from "./report-output.js";
import type { Result } from "./report.js";
import {
  type ChildFunctionOverrides,
  type ChildFunctions,
  ListingError,
  type OnceInput,
  packageVersion,
  run,
  runOnce,
  selectCases,
  shownPath,
} from "./run.js";
import { failureLines, formatTable, metricLine, paint } from "./table.js";
import { thrownMessage } from "./utils.js";

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Where the command prints: `process.stdout` and `process.stderr` fit. */
export interface Output {
  write(text: string): unknown;
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

/** What the command reads from and prints to, and the functions it starts children with. */
export interface CommandIo extends ChildFunctionOverrides {
  /** The directory positional files, `--out` and `--config` are relative to; `process.cwd()` by default. */
  readonly cwd?: string | undefined;
  readonly stdout?: Output | undefined;
  readonly stderr?: Output | undefined;
  readonly signals?: SignalSource | undefined;
}

/** Where a crash's issue link opens a new issue, its body following. */
const NEW_ISSUE = "https://github.com/jeffzi/repset/issues/new?body=";

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
// Progress
// ---------------------------------------------------------------------------

/** The frames of the live line's indicator, one per tick. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How long each indicator frame shows, in milliseconds. */
const FRAME_MS = 80;

/** Splits the live line into the characters a person sees, so a cut never splits one. */
const GRAPHEMES = new Intl.Segmenter();

/** The characters a terminal draws two columns wide: East Asian wide and full-width ones, and emoji. */
const WIDE =
  /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFF}]/u;

/** The columns a terminal gives one grapheme: two for a wide one, one otherwise. */
function columnsOf(grapheme: string): number {
  return WIDE.test(grapheme) ? 2 : 1;
}

/** Moves the cursor to the start of its row and erases the row. */
const CLEAR_ROW = "\r\x1b[2K";

/** What the command shows on stderr as each child starts. */
interface Progress {
  /** Starts counting the children of a phase that starts `total` of them. */
  planned(total: number): void;
  /** Shows that the phase's next child starts, doing what `text` says. */
  starting(text: string): void;
  /** Writes `text` to `output` above the live line, once a child started, so they never share a row. */
  above(output: Output, text: string): void;
  /** Stops the indicator and erases the live line; calling it again does nothing. */
  stop(): void;
}

/** Progress as one line per child, with no count, animation or cursor control. */
function linePerChild(stderr: Output): Progress {
  return {
    planned: () => undefined,
    starting: (text) => {
      stderr.write(`${text}\n`);
    },
    above: (output, text) => {
      output.write(text);
    },
    stop: () => undefined,
  };
}

/**
 * Progress as one live line on a terminal: `[i/n]`, then what the running child does, behind an
 * animated indicator. The line is cut to the terminal's width, so erasing its row erases all of it.
 * The indicator's timer is unreferenced: it never keeps the process alive.
 *
 * @param stderr - The terminal the line shows on.
 * @param color - Whether `stderr` shows color, which colors the indicator.
 * @returns The progress, showing nothing until the first child starts.
 */
function liveLine(stderr: Output, color: boolean): Progress {
  let total = 0;
  let started = 0;
  let doing = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = (): void => {
    // The last column stays empty: a row filled to it wraps on some terminals.
    let room = (stderr.columns ?? Number.POSITIVE_INFINITY) - 1;
    const kept: string[] = [];
    for (const { segment } of GRAPHEMES.segment(
      `${FRAMES[frame]} [${started}/${total}] ${doing}`,
    )) {
      room -= columnsOf(segment);
      if (room < 0) break;
      kept.push(segment);
    }
    const [indicator = "", ...rest] = kept;
    stderr.write(`${CLEAR_ROW}${paint("green", indicator, color)}${rest.join("")}`);
  };
  return {
    planned: (count) => {
      total = count;
      started = 0;
    },
    starting: (text) => {
      started += 1;
      doing = text;
      timer ??= setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        draw();
      }, FRAME_MS).unref();
      draw();
    },
    above: (output, text) => {
      stderr.write(CLEAR_ROW);
      output.write(text);
      draw();
    },
    stop: () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      stderr.write(CLEAR_ROW);
    },
  };
}

/** A live line on a terminal stderr whose `TERM` is not `dumb`, one line per child elsewhere. */
function progressOn(stderr: Output, color: boolean): Progress {
  const live = stderr.isTTY === true && process.env["TERM"] !== "dumb";
  return live ? liveLine(stderr, color) : linePerChild(stderr);
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
    onPlanned: (_phase, total) => {
      context.progress.planned(total);
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
  const progress = progressOn(stderr, colors.stderr);
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
      progress,
      findRuntime: io.findRuntime ?? realFindRuntime,
      startChild: io.startChild ?? realStartChild,
    };
    const actions = { run: measure, list, once };
    return exitCode(await actions[command.mode](command, context));
  } catch (error) {
    progress.stop();
    // Commander ends a run that printed the help or the version with an error of exit code 0.
    if (error instanceof CommanderError) return exitCode(0);
    if (!(error instanceof ConfigError)) throw error;
    printError(stderr, error, colors.stderr);
    return exitCode(2);
  } finally {
    for (const [signal, listener] of listeners) signals.off(signal, listener);
  }
}
