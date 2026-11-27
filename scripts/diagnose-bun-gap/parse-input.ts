/**
 * Parses the command line of the Bun timing-gap analysis and its JSON Lines run files: a header
 * line, then one reading per line.
 */
import { parseArgs } from "node:util";

import { isRecord } from "../../src/utils.js";
import { HEADER_FIELDS, READING_FIELDS, hasFields } from "./line-shape.js";
import type { Line } from "./line-shape.js";

/** The first line of a run file: the machine, the tool versions and the run's settings. */
export type Header = Line<"header", typeof HEADER_FIELDS>;

/** One timing of one body on one side, in one cycle of the run. */
export type Reading = Line<"reading", typeof READING_FIELDS>;

/** One run file: where it came from, the cloud it is labelled with, and its records. */
export interface Run {
  file: string;
  cloud: string;
  header: Header;
  readings: readonly Reading[];
}

/** The command line: the level gap in ns and each file with its cloud label. */
export interface Arguments {
  levelGap: number;
  inputs: { file: string; cloud: string }[];
}

const DEFAULT_LEVEL_GAP = 15;

function isHeader(value: unknown): value is Header {
  return isRecord(value) && value["kind"] === "header" && hasFields(value, HEADER_FIELDS);
}

function isReading(value: unknown): value is Reading {
  return isRecord(value) && value["kind"] === "reading" && hasFields(value, READING_FIELDS);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function parseLine(file: string, number: number, line: string): Header | Reading {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`${file} line ${number}: not valid JSON`, { cause: error });
  }
  // Files written before the header carried the matrix job have no `job`; they ran outside a
  // matrix, which `job: null` says.
  if (isRecord(value) && value["kind"] === "header" && !("job" in value)) {
    value = { ...value, job: null };
  }
  if (isHeader(value) || isReading(value)) {
    return value;
  }
  throw new Error(`${file} line ${number}: not a header or reading of the expected shape`);
}

/**
 * Validates the flags and splits each positional argument at its last `=` into a file and a cloud
 * label.
 *
 * @param argv - The arguments after the script path.
 * @returns The level gap, 15 ns unless `--level-gap` gives one, and each file with its cloud.
 * @throws Error naming the value when `--level-gap` is not a positive number.
 * @throws Error when no `<file>=<cloud>` argument is given.
 * @throws Error naming an argument that lacks `=`, a file or a cloud label.
 * @throws TypeError from `parseArgs` for an unknown option or an option missing its value.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "level-gap": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const gapText = values["level-gap"];
  const levelGap = gapText === undefined ? DEFAULT_LEVEL_GAP : Number(gapText);
  if (!Number.isFinite(levelGap) || levelGap <= 0) {
    throw new Error(`--level-gap takes a positive number of ns, got "${gapText}"`);
  }
  if (positionals.length === 0) {
    throw new Error("usage: analyze.ts [--level-gap <ns>] <file>=<cloud> [<file>=<cloud> ...]");
  }
  const inputs = positionals.map((argument) => {
    const at = argument.lastIndexOf("=");
    const cloud = argument.slice(at + 1);
    if (at < 1 || cloud === "") {
      throw new Error(`expected <file>=<cloud>, got "${argument}"`);
    }
    return { file: argument.slice(0, at), cloud };
  });
  return { levelGap, inputs };
}

/**
 * Parses one run file. Text after the last newline that is not valid JSON is the unfinished line a
 * stopped run leaves, and is dropped. A header without `job` reads as `job: null`.
 *
 * @param file - The file's path, named in errors.
 * @param cloud - The cloud label given for the file.
 * @param text - The file's contents.
 * @returns The run, with the header and every finished reading.
 * @throws Error naming the file and line of a line that is not valid JSON, not a header or
 *   reading of the expected shape, or a header after the first line.
 * @throws Error naming the file when its first line is not a header.
 */
export function parseRun(file: string, cloud: string, text: string): Run {
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  if (isJson(last)) {
    lines.push(last);
  }
  const [first, ...rest] = lines.map((line, index) => parseLine(file, index + 1, line));
  if (!isHeader(first)) {
    throw new Error(`${file}: the first line is not a header`);
  }
  const readings = rest.map((record, index) => {
    if (!isReading(record)) {
      throw new Error(`${file} line ${index + 2}: a second header`);
    }
    return record;
  });
  return { file, cloud, header: first, readings };
}
