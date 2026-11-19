/**
 * Case selection: finding the benchmark files, looking up the runtimes, and listing each file's
 * cases in a child.
 */
import { globSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

import type { ChildError } from "./child.js";
import {
  findRuntime as realFindRuntime,
  type FoundRuntime,
  startChild as realStartChild,
  type StartOptions,
} from "./children.js";
import { ConfigError, isFile, type ResolvedOptions } from "./options.js";

export interface SelectedCase {
  readonly id: string;
  /** The benchmark file that registers the case, as an absolute path. */
  readonly path: string;
  /** The file as the report writes it: relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly setupPerCall: boolean;
}

/** The runtimes and cases a run measures, or a stop that came during runtime discovery or listing. */
export type Selection =
  | {
      readonly status: "selected";
      readonly runtimes: readonly FoundRuntime[];
      readonly cases: readonly SelectedCase[];
    }
  | { readonly status: "stopped" };

export interface ChildFunctions {
  readonly findRuntime: typeof realFindRuntime;
  readonly startChild: typeof realStartChild;
}

/** {@link ChildFunctions} a caller may replace; each one it leaves out is the real function. */
export type ChildFunctionOverrides = {
  readonly [Name in keyof ChildFunctions]?: ChildFunctions[Name] | undefined;
};

export interface SelectInput extends ChildFunctionOverrides {
  readonly options: ResolvedOptions;
  /** The positional files, relative to `cwd`; when there are some, they replace `include`. */
  readonly files: readonly string[];
  readonly cwd: string;
  /** Ends the selection as stopped when it fires during runtime discovery or listing. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Receives the number of benchmark files to list once every runtime is found, before the first
   * listing child starts.
   */
  readonly onPlanned?: ((total: number) => void) | undefined;
}

/** A benchmark file whose listing child failed, with what the child left to print before it. */
export class ListingError extends ConfigError {
  override readonly name = "ListingError";
  readonly failureStack: string | null;
  /** The last 16 KiB of the listing child's stdout and stderr. */
  readonly output: string;

  /**
   * @param file - The benchmark file, as the report writes it.
   * @param error - The listing child's failure.
   * @param output - The listing child's output tail.
   */
  constructor(file: string, error: ChildError, output: string) {
    super(`cannot list the cases of ${file}: phase ${error.phase}: ${error.message}`);
    this.failureStack = error.stack;
    this.output = output;
  }
}

/**
 * Finds the files a glob pattern matches, never descending into `node_modules`.
 *
 * @param pattern - The glob pattern.
 * @param base - The directory the pattern is relative to.
 * @returns The files, as absolute paths sorted by path.
 * @throws {@link ConfigError} When a match exists but cannot be read.
 */
function globFiles(pattern: string, base: string): string[] {
  const matches = globSync(pattern, {
    cwd: base,
    exclude: (path) => basename(path) === "node_modules",
  })
    .map((match) => resolve(base, match))
    .filter((path) => isFile(path));
  // By the slash-separated path, by code unit, so the order is the same on every OS.
  return matches.toSorted((a, b) => {
    const [left, right] = [a.replaceAll(sep, "/"), b.replaceAll(sep, "/")];
    return left < right ? -1 : Number(left > right);
  });
}

/**
 * Finds a positional argument's files.
 *
 * @param argument - The argument: a file, or else a glob.
 * @param cwd - The directory the argument is relative to.
 * @returns The file the argument names, or else the files it matches as a glob.
 * @throws {@link ConfigError} When the argument names no file and matches none as a glob, or a
 *   path it names or matches cannot be read.
 */
function argumentFiles(argument: string, cwd: string): string[] {
  const named = resolve(cwd, argument);
  if (isFile(named)) return [named];
  const matched = globFiles(argument, cwd);
  if (matched.length === 0) throw new ConfigError(`no benchmark file matches ${argument}`);
  return matched;
}

/**
 * Finds the benchmark files of a selection.
 *
 * @param options - The resolved options, whose `include` patterns apply when `files` is empty.
 * @param files - The positional arguments, relative to `cwd`.
 * @param cwd - The directory the arguments are relative to.
 * @returns The files in the order their patterns are written, each one once.
 * @throws {@link ConfigError} When an argument matches no file, no `include` pattern matches one,
 *   or a path cannot be read.
 */
function benchmarkFiles(options: ResolvedOptions, files: readonly string[], cwd: string): string[] {
  const perPattern =
    files.length > 0
      ? files.map((argument) => argumentFiles(argument, cwd))
      : options.include.map((pattern) => globFiles(pattern, options.includeBase));
  const found = [...new Set(perPattern.flat())];
  if (found.length === 0) {
    throw new ConfigError(`no benchmark file matches include ${options.include.join(", ")}`);
  }
  return found;
}

/**
 * Rejects a listing in which two cases share an id, whether they register it from one file or
 * several.
 *
 * @param cases - The listed cases.
 * @throws {@link ConfigError} Naming the first id two cases share and the files that register it.
 */
function checkUniqueIds(cases: readonly SelectedCase[]): void {
  const seen = new Set<string>();
  const repeated = cases.find(({ id }) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  if (repeated === undefined) return;
  const files = new Set(cases.filter(({ id }) => id === repeated.id).map(({ file }) => file));
  throw new ConfigError(
    `more than one case has the id ${repeated.id}, in ${[...files].join(", ")}`,
  );
}

/**
 * Collects what starts a child from the resolved options; `nodeImport` is `undefined` when the
 * options have none.
 *
 * @param options - The resolved options.
 * @param signal - The caller's stop signal.
 * @returns The options' timeout and resolved `nodeImport`, and the signal.
 */
export function startOptions(
  options: ResolvedOptions,
  signal: AbortSignal | undefined,
): StartOptions {
  return { timeout: options.timeout, nodeImport: options.nodeImport?.resolved, signal };
}

/** `path` relative to `cwd` with `/` separators, as the report and the progress lines show it. */
export function shownPath(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll(sep, "/");
}

/**
 * Lists the cases of `files`, one listing child per file on `runtime`, in file order.
 *
 * @param files - The benchmark files, as absolute paths.
 * @param runtime - The runtime the listing children run on.
 * @param input - The options, the working directory, the stop signal, the plan callback and the
 *   child starter.
 * @returns The cases in file order, or `undefined` when the stop signal fired.
 * @throws {@link ListingError} When a listing child fails.
 * @throws {@link Error} What `onPlanned` or starting a listing child throws.
 */
async function listFiles(
  files: readonly string[],
  runtime: FoundRuntime,
  input: SelectInput,
): Promise<SelectedCase[] | undefined> {
  const { options, cwd, signal, startChild = realStartChild } = input;
  const childOptions = startOptions(options, signal);
  input.onPlanned?.(files.length);
  const cases: SelectedCase[] = [];
  for (const path of files) {
    if (signal?.aborted === true) return undefined;
    const file = shownPath(cwd, path);
    const outcome = await startChild(runtime, { mode: "list", file: path }, childOptions);
    if (outcome.status === "stopped") return undefined;
    if (outcome.status === "failed") throw new ListingError(file, outcome.error, outcome.output);
    for (const { id, setupPerCall } of outcome.result.cases) {
      cases.push({ id, path, file, setupPerCall });
    }
  }
  return cases;
}

/**
 * Selects the cases a run measures. Every runtime is looked up before any listing child starts.
 *
 * @param input - The options, the positional files, the working directory, the stop signal, the
 *   plan callback, and the functions that look a runtime up and start a child, the real ones by
 *   default.
 * @returns The runtimes with their versions and the selected cases, or a stop when the signal fired
 *   during runtime discovery or listing.
 * @throws {@link ConfigError} When an argument matches no file, a runtime cannot be found, a
 *   listing child fails (a {@link ListingError}), two cases share an id, or no case is selected.
 * @throws {@link Error} What `onPlanned` or starting a listing child throws, and the plain `Error`
 *   that finding the runtime this process runs on throws when `process.versions` holds no version
 *   for it.
 */
export async function selectCases(input: SelectInput): Promise<Selection> {
  const { options, files, cwd, signal, findRuntime = realFindRuntime } = input;
  const found = benchmarkFiles(options, files, cwd);
  const lookup = { timeout: options.timeout, signal };
  const looked = await Promise.all(
    options.runtimes.map(async (runtime) => findRuntime(runtime, lookup)),
  );
  const runtimes = looked.filter((runtime) => runtime !== undefined);
  if (runtimes.length < looked.length) return { status: "stopped" };
  const [first] = runtimes;
  if (first === undefined) throw new ConfigError("runtimes must name at least one runtime");

  const listed = await listFiles(found, first, input);
  if (listed === undefined) return { status: "stopped" };
  if (listed.length === 0) throw new ConfigError("no benchmark file registers a case");
  checkUniqueIds(listed);

  const { filter } = options;
  const cases =
    filter === undefined ? listed : listed.filter((selected) => filter.test(selected.id));
  if (cases.length === 0) throw new ConfigError(`no case id matches the filter ${String(filter)}`);
  return { status: "selected", runtimes, cases };
}
