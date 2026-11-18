import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { expect } from "vitest";

import type { StrictOmit } from "../src/command-line.js";
import { main } from "../src/command.js";
import {
  failedOutcome,
  findAny,
  measuredOutcome,
  ranOnce,
  starter as fakeStarter,
  type StartChild,
} from "./fake-children.js";
import { temporaryDir } from "./temporary-dir.js";

type Io = NonNullable<Parameters<typeof main>[1]>;

/** The benchmark files every workspace holds; the fake children never import them. */
const FILES = ["sort.bench.ts", "parse.bench.ts"];

/** The package's own version, which `--version` prints and the report records. */
export const VERSION = packageVersion();

/** The version the package's `package.json` holds, failing the suite when it holds none. */
function packageVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    return pkg.version;
  }
  throw new Error("package.json holds no version");
}

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

/** A stream stand-in that keeps what is written to it. */
interface Captured {
  text: string;
  write: (text: string) => boolean;
  readonly isTTY?: true;
  readonly getColorDepth?: () => number;
}

/** A stream stand-in with nothing written yet. */
export function captured(): Captured {
  const stream: Captured = {
    text: "",
    write: (text) => {
      stream.text += text;
      return true;
    },
  };
  return stream;
}

/** A stream stand-in that claims to be a terminal, with nothing written yet. */
export function terminal(): Captured {
  return Object.assign(captured(), { isTTY: true as const });
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

export type CommandIo = StrictOmit<Partial<Io>, "stdout" | "stderr"> & {
  readonly stdout?: Captured;
  readonly stderr?: Captured;
};

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
