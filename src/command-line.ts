/** The `repset` command line: its flags, its help, and what it asks the command for. */
import { createHelpConfig } from "@jeffzi/epaulettes";
import { Command as Parser } from "commander";

import type { Colors, Output } from "./command.js";
import { RUNTIMES, type Runtime } from "./measure/runtime.js";
import { ConfigError, isRuntime, type OptionsInput, QUOTED_RUNTIMES } from "./options.js";
import { paint } from "./table.js";
import { describe } from "./utils.js";

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Flags that cannot be given together, by name without the leading dashes. */
const EXCLUSIVE: readonly (readonly [string, string])[] = [
  ["list", "once"],
  ["list", "output"],
  ["list", "metric-lines"],
  ["once", "output"],
  ["once", "metric-lines"],
];

/** Decimal digits with an optional fraction: `Number` alone reads `""` as 0 and accepts `1e3`. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** The environment variable that fixes the calls per sample of every measuring child of a run. */
export const CALLS_PER_SAMPLE = "REPSET_CALLS_PER_SAMPLE";

/** The `--output` value that sends the report to stdout instead of a file. */
export const OUTPUT_STDOUT = "-";

/** The README's common commands; keep them in step with it. */
const EXAMPLES: readonly (readonly [string, string])[] = [
  ["repset benchmarks/sort.bench.ts", "Runs the benchmarks of that file only"],
  ["repset --filter '^sort/'", "Runs the cases whose id matches the regular expression"],
  ["repset --runtime node,bun", "Runs every case on Node, then on Bun"],
  ["repset --output report.json", "Writes the JSON report to report.json"],
  ["repset --once", "Runs every case once, without timing, to check it works"],
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
  readonly metricLines: boolean;
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
    .option(
      "-o, --output <file>",
      "Write the report there; - writes it to stdout and the table to stderr",
    )
    .option("--metric-lines", "Print one METRIC line per result on stdout and the table to stderr")
    .option("--list", "Print the selected case ids and exit")
    .option("--once", "Run every selected case once per runtime, with no timing")
    .option("--config <file>", "Read this config file instead of looking for one")
    .option("--no-color", "Print no color, even on a terminal")
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
    options.filter((option) => option.required).flatMap(({ short, long }) => [short, long]),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (arg === "--no-color") return true;
    if (takesValue.has(arg)) index += 1;
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
  if (given.has("metric-lines") && text("output") === OUTPUT_STDOUT) {
    throw new ConfigError("--metric-lines cannot be used with --output -");
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
    output: text("output"),
    metricLines: given.has("metric-lines"),
    callsPerSample: fixedCallsPerSample(process.env[CALLS_PER_SAMPLE]),
  };
}
