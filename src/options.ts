/**
 * Resolves the options a run uses from the caller's options, the config file and the defaults.
 *
 * Every failure is a {@link ConfigError}: the command exits 2 on that class and on nothing else.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "./config.js";
import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "./measure/measure.js";
import { RUNTIMES, type Runtime } from "./measure/runtime.js";
import { describe, property, thrownMessage } from "./utils.js";

/** A config that cannot be found, loaded or checked, or an option value that is out of range. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Builds the `ConfigError` for an operation that threw.
 *
 * @param message - What failed, without the cause.
 * @param error - The thrown value, kept as the error's `cause`.
 * @returns A `ConfigError` reading `<message>: <the thrown value's message>`.
 */
function failedWith(message: string, error: unknown): ConfigError {
  return new ConfigError(`${message}: ${thrownMessage(error)}`, { cause: error });
}

/** What the caller passes: the options of {@link Config}, plus the ones only a run takes. */
export interface OptionsInput extends Config {
  /** Keeps only the cases whose id this expression, compiled with the `u` flag, matches. */
  readonly filter?: string | undefined;
  /** The config file, relative to `cwd`; `false` reads none; `undefined` searches `cwd`. */
  readonly config?: string | false | undefined;
  /** Where a config file is searched for, and what a relative `config` path resolves against. */
  readonly cwd: string;
}

/** A module Node children import first. */
export interface NodeImport {
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
  readonly minSamples: number;
  readonly timeout: number;
  readonly nodeImport: NodeImport | undefined;
  readonly filter: RegExp | undefined;
}

type OptionName = keyof Config;

const CONFIG_NAMES = [
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
  minSamples: true,
  timeout: true,
  nodeImport: true,
};

const OPTION_NAMES: ReadonlySet<string> = new Set(Object.keys(OPTION_KEYS));

/** The largest delay a Node timer keeps; a larger one fires after 1 ms. */
const MAX_TIMEOUT = 2_147_483_647;

const DEFAULT_INCLUDE = ["**/*.bench.{ts,mts,js,mjs}"];
const DEFAULT_RUNTIMES: readonly Runtime[] = ["node"];
const DEFAULT_TIMEOUT = 600_000;

/**
 * Whether `path` names a file; a path that does not exist is not one.
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
  if (options.config === false) return undefined;
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
    if (value !== undefined && !OPTION_NAMES.has(key)) {
      throw new ConfigError(`the config file ${file} sets ${key}, which is not an option`);
    }
  }
  return Object.fromEntries(entries);
}

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

function checkedRuntimes(value: unknown): readonly Runtime[] {
  if (!Array.isArray(value)) throw invalid("runtimes", "an array of runtimes", value);
  const names: readonly unknown[] = value;
  if (names.length === 0) throw new ConfigError("runtimes must name at least one runtime, got []");
  const runtimes: Runtime[] = [];
  for (const name of names) {
    if (!isRuntime(name)) throw invalid("runtimes", 'an array of "node" and "bun"', name);
    if (runtimes.includes(name)) throw new ConfigError(`runtimes names ${describe(name)} twice`);
    runtimes.push(name);
  }
  return runtimes;
}

function checkedMinTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("minTime", "a finite number of 0 or more", value);
  }
  return value;
}

function checkedMinSamples(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid("minSamples", "an integer of 1 or more", value);
  }
  return value;
}

function checkedTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT) {
    throw invalid("timeout", `an integer from 1 to ${MAX_TIMEOUT}`, value);
  }
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
    minSamples: given(values.minSamples, checkedMinSamples),
    timeout: given(values.timeout, checkedTimeout),
    nodeImport: given(values.nodeImport, (value) => checkedString("nodeImport", value)),
  };
}

function resolvedNodeImport(
  caller: string | undefined,
  fromFile: string | undefined,
  file: string | undefined,
): NodeImport | undefined {
  if (caller !== undefined) return { written: caller, resolved: caller };
  if (fromFile === undefined || file === undefined) return undefined;
  const relative = fromFile.startsWith("./") || fromFile.startsWith("../");
  return { written: fromFile, resolved: relative ? resolve(dirname(file), fromFile) : fromFile };
}

/**
 * Resolves the options a run uses: a value the caller gives beats the config file's, which beats
 * the default.
 *
 * With no config named, `options.cwd` is searched for `repset.config.ts`, `.mts`, `.js` and
 * `.mjs`. Each value is checked whether the config file or the caller gave it, and a key holding
 * `undefined` counts as absent. `include` is relative to the config file's directory, or to
 * `options.cwd` when no config file was read. A `nodeImport` from the config file that starts
 * `./` or `../` is resolved against the config file's directory.
 *
 * @param options - The caller's options, the config to read and the working directory.
 * @returns The checked and merged options.
 * @throws {@link ConfigError} When the config file is missing, ambiguous, fails to import, has
 *   no plain-object default export or sets an unknown key, or when any value is invalid.
 */
export async function resolveOptions(options: OptionsInput): Promise<ResolvedOptions> {
  const file = configPath(options);
  const fromFile = file === undefined ? {} : checkedConfig(await loadConfig(file));
  const caller = checkedConfig(options);
  return {
    include: caller.include ?? fromFile.include ?? DEFAULT_INCLUDE,
    includeBase: file === undefined ? options.cwd : dirname(file),
    runtimes: caller.runtimes ?? fromFile.runtimes ?? DEFAULT_RUNTIMES,
    minTime: caller.minTime ?? fromFile.minTime ?? DEFAULT_MIN_TIME,
    minSamples: caller.minSamples ?? fromFile.minSamples ?? DEFAULT_MIN_SAMPLES,
    timeout: caller.timeout ?? fromFile.timeout ?? DEFAULT_TIMEOUT,
    nodeImport: resolvedNodeImport(caller.nodeImport, fromFile.nodeImport, file),
    filter: given(options.filter, checkedFilter),
  };
}
