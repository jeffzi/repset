/**
 * Resolves the options a run uses from the caller's options, the config file and the defaults.
 *
 * Every failure is a {@link ConfigError}: the command exits 2 on that class and on nothing else.
 *
 * Every measuring child loads the package entry, which re-exports {@link Config} and
 * {@link defineConfig} from here, so this module imports at run time only what a measuring child
 * loads already: Node builtins, the `measure` modules and the generic helpers in `utils`.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "./measure/measure.js";
import { RUNTIMES, type Runtime } from "./measure/runtime.js";
import { describe, property, quotedList, thrownMessage } from "./utils.js";

/** What a run can measure of each case. */
export const MEASURES = ["time", "memory"] as const;

/** One thing a run can measure of each case. */
export type Measure = (typeof MEASURES)[number];

/** The options a config file stores. Each is optional; `undefined` counts as absent. */
export interface Config {
  /** Globs for benchmark files, relative to the config file. `node_modules` is never searched. */
  readonly include?: readonly string[] | undefined;
  readonly runtimes?: readonly Runtime[] | undefined;
  /** Timing lasts at least this many milliseconds. */
  readonly minTime?: number | undefined;
  /** Timing takes at least this many samples. */
  readonly minSampleCount?: number | undefined;
  /** How many repetitions each contest runs in; unset leaves the count to the contest's size. */
  readonly contestRepetitionCount?: number | undefined;
  /**
   * Prints each failed case's stack and its child's output to stderr as it fails, and keeps each
   * measurement's `gc` in the report, where it is `null` otherwise; off by default.
   */
  readonly debug?: boolean | undefined;
  /** The longest one child may run, in milliseconds; a child that passes it fails its case. */
  readonly timeout?: number | undefined;
  /** A module Node children import first, such as a TypeScript loader. Bun children ignore it. */
  readonly nodeImport?: string | undefined;
  /** What to measure of each case: `time`, `memory` or both, each named once. */
  readonly measure?: readonly Measure[] | undefined;
}

/** Returns `config` unchanged: it types a config file, and {@link resolveOptions} checks it. */
export function defineConfig(config: Config): Config {
  return config;
}

/**
 * A problem with the setup the person running repset can fix: a config, option or flag that is
 * invalid, a selection that matches no file or case, a runtime that cannot be found or probed, or a
 * report that cannot be written. The command prints its message without a stack and exits 2.
 */
export class ConfigError extends Error {
  override readonly name: string = "ConfigError";
}

/**
 * Builds the `ConfigError` for an operation that threw.
 *
 * @param message - What failed, without the cause.
 * @param error - The thrown value, kept as the error's `cause`.
 * @returns A `ConfigError` reading `<message>: <the thrown value's message>`.
 */
export function failedWith(message: string, error: unknown): ConfigError {
  return new ConfigError(`${message}: ${thrownMessage(error)}`, { cause: error });
}

/** What the caller passes: the options of {@link Config}, plus the ones only a run takes. */
export interface OptionsInput extends Config {
  /** Keeps only the cases whose id this expression, compiled with the `u` flag, matches. */
  readonly filter?: string | undefined;
  /** The config file, relative to `cwd`; `undefined` searches `cwd`. */
  readonly config?: string | undefined;
  /** Where a config file is searched for, and what a relative `config` path resolves against. */
  readonly cwd: string;
}

/** A module Node children import first. */
interface NodeImport {
  /** The value as the config file or the caller wrote it, which the report records. */
  readonly written: string;
  /** The value Node children receive. */
  readonly resolved: string;
}

/** The options a run uses, each one checked and merged. */
export interface ResolvedOptions {
  readonly include: readonly string[];
  /** The directory `include` globs are relative to. */
  readonly includeBase: string;
  readonly runtimes: readonly Runtime[];
  readonly minTime: number;
  readonly minSampleCount: number;
  /** `undefined` leaves the count of repetitions to each contest's size. */
  readonly contestRepetitionCount?: number | undefined;
  readonly debug: boolean;
  readonly timeout: number;
  readonly nodeImport: NodeImport | undefined;
  readonly filter: RegExp | undefined;
  /** In the order the config file or the caller wrote it. */
  readonly measure: readonly Measure[];
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

type OptionName = keyof Config;

/** The config files repset looks for in the directory it starts in, when no option names one. */
export const CONFIG_NAMES: readonly string[] = [
  "repset.config.ts",
  "repset.config.mts",
  "repset.config.js",
  "repset.config.mjs",
];

/** Every key of {@link Config}: a key missing here fails to compile. */
const OPTION_KEYS: Readonly<Record<OptionName, true>> = {
  include: true,
  runtimes: true,
  minTime: true,
  minSampleCount: true,
  contestRepetitionCount: true,
  debug: true,
  timeout: true,
  nodeImport: true,
  measure: true,
};

/** The largest delay a Node timer keeps; a larger one fires after 1 ms. */
const MAX_TIMEOUT = 2_147_483_647;

/** The patterns that pick the benchmark files when no option sets `include`. */
export const DEFAULT_INCLUDE: readonly string[] = ["**/*.bench.{ts,mts,js,mjs}"];
/** The runtimes a run uses when no option sets `runtimes`. */
export const DEFAULT_RUNTIMES: readonly Runtime[] = ["node"];
/** How many milliseconds a child may run when no option sets `timeout`. */
export const DEFAULT_TIMEOUT = 600_000;
/** What a run measures when no option sets `measure`. */
export const DEFAULT_MEASURE: readonly Measure[] = ["time"];

/**
 * Whether `path` names a regular file; a missing path or a directory is not an error.
 *
 * @param path - The path to check.
 * @returns `true` for a file, `false` for a missing path or a directory.
 * @throws {@link ConfigError} When the path exists but cannot be read, such as for a permission
 *   error.
 */
export function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (error) {
    throw failedWith(`cannot read ${path}`, error);
  }
}

function configPath(options: OptionsInput): string | undefined {
  if (options.config !== undefined) {
    const named = resolve(options.cwd, options.config);
    if (!isFile(named)) throw new ConfigError(`no config file at ${named}`);
    return named;
  }
  const found = CONFIG_NAMES.map((name) => join(options.cwd, name)).filter((path) => isFile(path));
  if (found.length > 1) {
    throw new ConfigError(`found more than one config file: ${found.join(", ")}`);
  }
  return found[0];
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function loadConfig(file: string): Promise<Readonly<Record<string, unknown>>> {
  let namespace: unknown;
  try {
    // A file URL, unlike a path, imports a Windows path or a name holding `#` or `?`.
    namespace = await import(pathToFileURL(file).href);
  } catch (error) {
    throw failedWith(`cannot load the config file ${file}`, error);
  }
  const exported = property(namespace, "default");
  if (!isPlainObject(exported)) {
    throw new ConfigError(
      `the config file ${file} must export a plain object as default, got ${describe(exported)}`,
    );
  }
  let entries: [string, unknown][];
  try {
    // Reading every value once here turns a getter that throws into this file's error.
    entries = Object.entries(exported);
  } catch (error) {
    throw failedWith(`cannot read the config file ${file}`, error);
  }
  for (const [key, value] of entries) {
    if (value !== undefined && !Object.hasOwn(OPTION_KEYS, key)) {
      throw new ConfigError(`the config file ${file} sets ${key}, which is not an option`);
    }
  }
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

function invalid(option: string, rule: string, value: unknown): ConfigError {
  return new ConfigError(`${option} must be ${rule}, got ${describe(value)}`);
}

function checkedInclude(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw invalid("include", "an array of strings", value);
  const globs: readonly unknown[] = value;
  const index = globs.findIndex((glob) => typeof glob !== "string");
  if (index !== -1) throw invalid("include", "an array of strings", globs[index]);
  return globs.filter((glob) => typeof glob === "string");
}

/** Whether `value` names a runtime repset runs on. */
export function isRuntime(value: unknown): value is Runtime {
  return RUNTIMES.some((runtime) => runtime === value);
}

/** Every runtime repset runs on, each quoted: `"node" and "bun"`. */
export const QUOTED_RUNTIMES = quotedList(RUNTIMES, "and");

/** An option that lists names of a closed set: its key, what one name is, and the set. */
interface NameOption<T> {
  readonly option: string;
  readonly noun: string;
  readonly quoted: string;
  readonly isName: (value: unknown) => value is T;
}

/** Checks an option that lists at least one name of a closed set, each name once. */
function checkedNames<T>(
  { option, noun, quoted, isName }: NameOption<T>,
  value: unknown,
): readonly T[] {
  if (!Array.isArray(value)) throw invalid(option, `an array of ${noun}s`, value);
  const names: readonly unknown[] = value;
  if (names.length === 0) throw new ConfigError(`${option} must name at least one ${noun}, got []`);
  const checked: T[] = [];
  for (const name of names) {
    if (!isName(name)) throw invalid(option, `an array of ${quoted}`, name);
    if (checked.includes(name)) throw new ConfigError(`${option} names ${describe(name)} twice`);
    checked.push(name);
  }
  return checked;
}

function checkedRuntimes(value: unknown): readonly Runtime[] {
  return checkedNames(
    { option: "runtimes", noun: "runtime", quoted: QUOTED_RUNTIMES, isName: isRuntime },
    value,
  );
}

/** Whether `value` names something a run can measure. */
export function isMeasure(value: unknown): value is Measure {
  return MEASURES.some((measure) => measure === value);
}

/** Everything a run can measure, each quoted: `"time" and "memory"`. */
export const QUOTED_MEASURES = quotedList(MEASURES, "and");

function checkedMeasure(value: unknown): readonly Measure[] {
  return checkedNames(
    { option: "measure", noun: "measure", quoted: QUOTED_MEASURES, isName: isMeasure },
    value,
  );
}

function checkedMinTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("minTime", "a finite number of 0 or more", value);
  }
  return value;
}

function checkedPositiveInteger(option: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(option, "an integer of 1 or more", value);
  }
  return value;
}

function checkedTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT) {
    throw invalid("timeout", `an integer from 1 to ${MAX_TIMEOUT}`, value);
  }
  return value;
}

function checkedBoolean(option: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid(option, "a boolean", value);
  return value;
}

function checkedString(option: string, value: unknown): string {
  if (typeof value !== "string") throw invalid(option, "a string", value);
  return value;
}

function checkedFilter(value: unknown): RegExp {
  const source = checkedString("filter", value);
  try {
    return new RegExp(source, "u");
  } catch (error) {
    throw failedWith(`filter must be a regular expression, got ${describe(source)}`, error);
  }
}

function given<T>(value: unknown, check: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value);
}

function checkedConfig(values: Readonly<Partial<Record<OptionName, unknown>>>): Config {
  return {
    include: given(values.include, checkedInclude),
    runtimes: given(values.runtimes, checkedRuntimes),
    minTime: given(values.minTime, checkedMinTime),
    minSampleCount: given(values.minSampleCount, (value) =>
      checkedPositiveInteger("minSampleCount", value),
    ),
    contestRepetitionCount: given(values.contestRepetitionCount, (value) =>
      checkedPositiveInteger("contestRepetitionCount", value),
    ),
    debug: given(values.debug, (value) => checkedBoolean("debug", value)),
    timeout: given(values.timeout, checkedTimeout),
    nodeImport: given(values.nodeImport, (value) => checkedString("nodeImport", value)),
    measure: given(values.measure, checkedMeasure),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolvedNodeImport(
  caller: string | undefined,
  fromFile: string | undefined,
  file: string | undefined,
): NodeImport | undefined {
  if (caller !== undefined) return { written: caller, resolved: caller };
  if (fromFile === undefined || file === undefined) return undefined;
  const relative = fromFile.startsWith("./") || fromFile.startsWith("../");
  // Node's `--import` parses its argument as a URL: a bare path breaks on `#`, `?` or `%` in a
  // directory name, and on a Windows drive letter.
  const resolved = relative ? pathToFileURL(resolve(dirname(file), fromFile)).href : fromFile;
  return { written: fromFile, resolved };
}

/**
 * Resolves the options a run uses: a value the caller gives beats the config file's, which beats
 * the default.
 *
 * With no config named, `options.cwd` is searched for `repset.config.ts`, `.mts`, `.js` and
 * `.mjs`. Each value is checked whether the config file or the caller gave it, and a key holding
 * `undefined` counts as absent. `include` is relative to the config file's directory, or to
 * `options.cwd` when no config file was read. A `nodeImport` from the config file that starts
 * `./` or `../` becomes the file URL of that path beside the config file.
 *
 * @param options - The caller's options, the config to read and the working directory.
 * @returns The checked and merged options.
 * @throws {@link ConfigError} When the config file is missing, ambiguous, cannot be read though its
 *   path exists, fails to import, has no plain-object default export, has a default export whose
 *   values cannot be read, or sets an unknown key, or when any value is invalid.
 */
export async function resolveOptions(options: OptionsInput): Promise<ResolvedOptions> {
  const file = configPath(options);
  const fromFile = file === undefined ? {} : checkedConfig(await loadConfig(file));
  const caller = checkedConfig(options);
  const merged = <K extends OptionName>(key: K): Config[K] => caller[key] ?? fromFile[key];
  return {
    include: merged("include") ?? DEFAULT_INCLUDE,
    includeBase: file === undefined ? options.cwd : dirname(file),
    runtimes: merged("runtimes") ?? DEFAULT_RUNTIMES,
    minTime: merged("minTime") ?? DEFAULT_MIN_TIME,
    minSampleCount: merged("minSampleCount") ?? DEFAULT_MIN_SAMPLES,
    contestRepetitionCount: merged("contestRepetitionCount"),
    debug: merged("debug") ?? false,
    timeout: merged("timeout") ?? DEFAULT_TIMEOUT,
    nodeImport: resolvedNodeImport(caller.nodeImport, fromFile.nodeImport, file),
    filter: given(options.filter, checkedFilter),
    measure: merged("measure") ?? DEFAULT_MEASURE,
  };
}
