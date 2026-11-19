/** The `repset` command line: its flags, its help, and what it asks the command for. */
import { createHelpConfig } from "@jeffzi/epaulettes";
import { Command as Parser } from "commander";

import type { Colors, Output } from "./command.js";
import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "./measure/measure.js";
import { RUNTIMES, type Runtime } from "./measure/runtime.js";
import {
  CONFIG_NAMES,
  ConfigError,
  DEFAULT_INCLUDE,
  DEFAULT_RUNTIMES,
  DEFAULT_TIMEOUT,
  isRuntime,
  type OptionsInput,
  QUOTED_RUNTIMES,
} from "./options.js";
import { paint } from "./table.js";
import { describe } from "./utils.js";

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Flags that cannot be given together, by name without the leading dashes. */
const EXCLUSIVE: readonly (readonly [string, string])[] = [
  ["list", "once"],
  ["list", "output"],
  ["once", "output"],
];

/** Decimal digits with an optional fraction: `Number` alone reads `""` as 0 and accepts `1e3`. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** The environment variable that fixes the calls per sample of every measuring child of a run. */
export const CALLS_PER_SAMPLE = "REPSET_CALLS_PER_SAMPLE";

/** The `--output` value that sends the report to stdout instead of a file. */
export const OUTPUT_STDOUT = "-";

const DESCRIPTION =
  "Benchmarks the cases in the given files, or in every file the config's include patterns " +
  `match (default: ${DEFAULT_INCLUDE.join(", ")}).`;

/** Every flag but help and version, with its help line, in the order the help lists them. */
const OPTIONS: readonly (readonly [string, string])[] = [
  ["--filter <regex>", "Run only the cases whose id matches this regular expression"],
  [
    "--runtime <list>",
    `Runtimes to run on, comma-separated, in this order: ${RUNTIMES.join(", ")} ` +
      `(default: ${DEFAULT_RUNTIMES.join(",")})`,
  ],
  [
    "--min-time <ms>",
    `Time each case for at least this many milliseconds (default: ${DEFAULT_MIN_TIME})`,
  ],
  [
    "--min-samples <n>",
    `Take at least this many samples of each case (default: ${DEFAULT_MIN_SAMPLES})`,
  ],
  ["--rounds <n>", "Run each contest in this many rounds (default: by contest size)"],
  [
    "--timeout <ms>",
    "Fail a case that takes longer than this many milliseconds on one runtime " +
      `(default: ${DEFAULT_TIMEOUT})`,
  ],
  ["--node-import <module>", "Load this module before each benchmark file on Node, such as tsx"],
  [
    "-o, --output <file>",
    `Write the JSON report to <file>; "${OUTPUT_STDOUT}" writes it to stdout and the table to stderr`,
  ],
  ["--list", "List the selected case ids without running them"],
  ["--once", "Run each selected case once on each runtime, without timing, to check it works"],
  ["--config <file>", `Use this config file instead of looking for ${CONFIG_NAMES.join(", ")}`],
  ["--no-color", "Turn off color, even on a terminal"],
];

/** The README's common commands; keep them in step with it. */
const EXAMPLES: readonly (readonly [string, string])[] = [
  ["repset benchmarks/sort.bench.ts", "Run only the cases in that file"],
  ["repset --filter '^sort/'", "Run the cases whose id starts with sort/"],
  ["repset --runtime node,bun", "Run every case on Node, then on Bun"],
  ["repset -o report.json", "Also write the JSON report to report.json"],
  ["repset --once", "Run every case once, without timing, to check it works"],
];

/** The project's repository on GitHub, which the help and the crash report link to. */
export const REPOSITORY = "https://github.com/jeffzi/repset";

const README = `${REPOSITORY}#readme`;

interface CommandInput extends StrictOmit<OptionsInput, "cwd"> {
  readonly files: readonly string[] | undefined;
}

export interface Command {
  readonly mode: "run" | "list" | "once";
  readonly input: CommandInput;
  /** The `--output` value as written: a file relative to the working directory, or `-` for stdout. */
  readonly output: string | undefined;
  /** The calls per sample `REPSET_CALLS_PER_SAMPLE` fixes for a run, or `undefined` when unset. */
  readonly callsPerSample: number | undefined;
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
export function commandLine(version: string, stdout: Output, colors: Colors): Parser {
  const parser = new Parser("repset").description(DESCRIPTION).argument("[file...]");
  for (const [flags, description] of OPTIONS) parser.option(flags, description);
  return parser
    .helpOption("-h, --help", "Print this help")
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
 * Whether the command line asks for no color, read as the parser reads it: `--no-color` before a
 * `--` terminator, and not as the value a value flag takes. It is read before the command line is
 * checked, so a usage error honors it too.
 *
 * @param args - The command's arguments.
 * @returns Whether `--no-color` is given.
 */
export function noColorGiven(args: readonly string[]): boolean {
  const options = commandLine("", { write: () => true }, { stdout: false, stderr: false }).options;
  const takesValue = new Set(
    options
      .filter((option) => option.required)
      .flatMap(({ short, long }) => [short, long])
      .filter((flag): flag is string => flag !== undefined),
  );
  const remaining = args[Symbol.iterator]();
  for (const arg of remaining) {
    if (arg === "--") return false;
    if (arg === "--no-color") return true;
    if (takesValue.has(arg)) remaining.next();
  }
  return false;
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
export function parseCommand(args: readonly string[], parser: Parser): Command {
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
      rounds: decimal("rounds", text("rounds")),
      timeout: decimal("timeout", text("timeout")),
      nodeImport: text("nodeImport"),
      config: text("config"),
    },
    output: text("output"),
    callsPerSample: fixedCallsPerSample(process.env[CALLS_PER_SAMPLE]),
  };
}
