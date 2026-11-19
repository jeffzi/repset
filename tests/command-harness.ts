import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { expect, vi } from "vitest";

import type { StrictOmit } from "../src/command-line.js";
import { main } from "../src/command.js";
import type { Report, Result } from "../src/report.js";
import {
  failedOutcome,
  findAny,
  measuredOutcome,
  ranOnce,
  starter as fakeStarter,
  type StartChild,
} from "./fake-children.js";
import { parseReport, reportAt } from "./report-file.js";
import { temporaryDir } from "./temporary-dir.js";

type Io = NonNullable<Parameters<typeof main>[1]>;

/** The benchmark files every workspace holds; the fake children never import them. */
const FILES = ["sort.bench.ts", "parse.bench.ts"];

/** The one case the fake listing child finds in `file`. */
function caseOf(file: string): string {
  return `${basename(file, ".bench.ts")}/fast`;
}

/** A child starter listing `<file stem>/fast` per file and answering the rest with `answer`. */
export function starter(answer: Parameters<typeof fakeStarter>[1]): StartChild {
  return fakeStarter((file) => ({ id: caseOf(file), setupPerCall: false }), answer);
}

/** A child starter that measures every case and runs every once case. */
export const measuresAll = starter((request) =>
  request.mode === "measure" ? measuredOutcome(4656) : ranOnce,
);

/** A child starter that fails `parse/fast` in phase `fn` with `kiwi` and runs every other case. */
export const failsParse = starter((request, runtime, options) =>
  request.id === "parse/fast"
    ? failedOutcome("fn", "kiwi")
    : measuresAll(runtime, request, options),
);

/** A child starter that lists, then fails the command with a plain error if a case starts. */
export const startsNoCase = starter(() => {
  throw new Error("a case started");
});

/** Called once a write is done: with the error when it failed, with `null` when it succeeded. */
type WriteDone = (error: Error | null) => void;

/**
 * A stream stand-in that keeps what is written to it, even once its writes fail. A failed write
 * reports its error as Node does, after the write returns: to the write's callback, then once, as
 * an `error` event.
 */
interface Captured extends EventEmitter {
  text: string;
  write: (text: string, done?: WriteDone) => boolean;
  /** Fails every later write with `cause`, or an error carrying it as its code, and emits it now. */
  fail: (cause: string | Error) => void;
  /** Emits the error a held stand-in's failed writes reported, as Node does once the write returned. */
  emitHeld: () => void;
  readonly isTTY?: true;
  readonly getColorDepth?: () => number;
}

/** The error a stream write failing with `code` reports. */
function writeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: "write" });
}

/**
 * A stream stand-in whose writes fail with `failure` until told otherwise; when `held`, a failed
 * write's `error` event waits for `emitHeld`.
 */
function standIn(failure: Error | undefined, held = false): Captured {
  let error = failure;
  let reported = false;
  const emit = (): void => {
    if (error === undefined || reported) return;
    reported = true;
    stream.emit("error", error);
  };
  const report = (): void => {
    if (!held) emit();
  };
  const stream: Captured = Object.assign(new EventEmitter(), {
    text: "",
    write: (text: string, done?: WriteDone): boolean => {
      stream.text += text;
      const failed = error;
      process.nextTick(() => {
        done?.(failed ?? null);
        report();
      });
      return failed === undefined;
    },
    fail: (cause: string | Error): void => {
      error = typeof cause === "string" ? writeError(cause) : cause;
      report();
    },
    emitHeld: emit,
  });
  return stream;
}

/** A stream stand-in with nothing written yet. */
export function captured(): Captured {
  return standIn(undefined);
}

/** A stream stand-in whose reader went away before the run: every write fails with `code`. */
export function closed(code: string): Captured {
  return standIn(writeError(code));
}

/**
 * A stream stand-in whose reader went away before the run, whose failed writes report `code` to
 * their callbacks and hold their `error` event until `emitHeld`.
 */
export function closedHeld(code: string): Captured {
  return standIn(writeError(code), true);
}

/** A stream stand-in that claims to be a terminal, with nothing written yet. */
export function terminal(): Captured {
  return Object.assign(captured(), { isTTY: true as const });
}

/** Clears the color variables and claims a 256-color terminal, so a terminal stream shows color. */
export function stubColorTerminalEnv(): void {
  vi.stubEnv("NO_COLOR", undefined);
  vi.stubEnv("FORCE_COLOR", undefined);
  vi.stubEnv("TERM", "xterm-256color");
}

/** Whether `text` holds an escape code. */
export function styled(text: string): boolean {
  return text !== stripVTControlCharacters(text);
}

/** A fresh working directory holding the empty benchmark files, removed when the test ends. */
export function workspace(): string {
  const dir = temporaryDir("repset-command-");
  for (const file of FILES) writeFileSync(join(dir, file), "");
  return dir;
}

export interface Ended {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandIo extends StrictOmit<Partial<Io>, "stdout" | "stderr"> {
  readonly stdout?: Captured;
  readonly stderr?: Captured;
}

/** Runs the command in `cwd` with the fake lookup, a measuring starter and a silent signal source. */
export async function command(
  cwd: string,
  args: readonly string[],
  io: CommandIo = {},
): Promise<Ended> {
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

/** Runs the two workspace files with `args` and `--output report.json`, returning what ended and the report. */
export async function runWithReport(
  args: readonly string[],
  io: CommandIo = {},
): Promise<Ended & { readonly report: Report }> {
  const dir = workspace();
  const ended = await command(dir, [...FILES, ...args, "--output", "report.json"], io);
  return { ...ended, report: reportAt(join(dir, "report.json")) };
}

/** Runs the two workspace files with `--output -`, returning what ended and the results stdout holds. */
export async function runToStdout(
  io: CommandIo = {},
): Promise<Ended & { readonly results: readonly Result[] }> {
  const ended = await command(workspace(), [...FILES, "--output", "-"], io);
  return { ...ended, results: parseReport(ended.stdout, "stdout").results };
}

/** Puts a non-empty directory at `path`, so renaming a file over it fails. */
export function blockWrites(path: string): void {
  rmSync(path, { force: true });
  mkdirSync(join(path, "keep"), { recursive: true });
}

/** Removes what {@link blockWrites} put at `path`. */
export function unblockWrites(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Matches a line that holds each of `words` as a whole word, in any order. */
export function naming(...words: string[]): unknown {
  const ahead = words
    .map((word) => `(?=.*\\b${word.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b)`)
    .join("");
  return expect.stringMatching(new RegExp(`^${ahead}`));
}

/** The lines of `text`, without the newline that ends the last one. */
export function linesOf(text: string): string[] {
  return text.trimEnd().split("\n");
}
