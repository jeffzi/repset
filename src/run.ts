/**
 * Selecting the cases a run measures: finding the benchmark files, looking up the runtimes, and
 * listing each file's cases in a child.
 */
import { globSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

import type { ChildError } from "./child.js";
import {
  findRuntime as realFindRuntime,
  type FoundRuntime,
  startChild as realStartChild,
} from "./children.js";
import { ConfigError, type ResolvedOptions } from "./options.js";

/** A case the run measures. */
export interface SelectedCase {
  readonly id: string;
  /** The benchmark file that registers the case, as an absolute path. */
  readonly path: string;
  /** The file as the report writes it: relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly setupPerCall: boolean;
}

/** The runtimes and cases a run measures, or a stop that came during listing. */
export type Selection =
  | {
      readonly status: "selected";
      readonly runtimes: readonly FoundRuntime[];
      readonly cases: readonly SelectedCase[];
    }
  | { readonly status: "stopped" };

/** What a selection reads, and the functions it looks runtimes up and starts children with. */
export interface SelectInput {
  readonly options: ResolvedOptions;
  /** The positional files, relative to `cwd`; when there are some, they replace `include`. */
  readonly files: readonly string[];
  readonly cwd: string;
  /** Ends the selection as stopped when it fires during listing. */
  readonly signal?: AbortSignal | undefined;
  readonly findRuntime?: typeof realFindRuntime | undefined;
  readonly startChild?: typeof realStartChild | undefined;
}

/** A benchmark file whose listing child failed, with what the child left to print before it. */
export class ListingError extends ConfigError {
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

/** `path` with `/` separators, whatever the OS. */
function slashed(path: string): string {
  return path.split(sep).join("/");
}

/** The files `pattern` matches under `base`, as absolute paths sorted by path, never in `node_modules`. */
function globFiles(pattern: string, base: string): string[] {
  const matches = globSync(pattern, {
    cwd: base,
    exclude: (path) => basename(path) === "node_modules",
  })
    .map((match) => resolve(base, match))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path, key: slashed(path) }));
  matches.sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)));
  return matches.map((match) => match.path);
}

/** A positional argument's files: the file it names, or else the files it matches as a glob. */
function argumentFiles(argument: string, cwd: string): string[] {
  const named = resolve(cwd, argument);
  if (statSync(named, { throwIfNoEntry: false })?.isFile() === true) return [named];
  const matched = globFiles(argument, cwd);
  if (matched.length === 0) throw new ConfigError(`no benchmark file matches ${argument}`);
  return matched;
}

/** The benchmark files of a selection, in the order their patterns are written, each one once. */
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

/** Throws a `ConfigError` naming the first id two cases share and the files that register it. */
function checkUniqueIds(cases: readonly SelectedCase[]): void {
  const filesById = new Map<string, Set<string>>();
  let firstRepeated: string | undefined;
  for (const selected of cases) {
    const files = filesById.get(selected.id);
    if (files === undefined) {
      filesById.set(selected.id, new Set([selected.file]));
    } else {
      files.add(selected.file);
      firstRepeated ??= selected.id;
    }
  }
  if (firstRepeated === undefined) return;
  const files = [...(filesById.get(firstRepeated) ?? [])].join(", ");
  throw new ConfigError(`more than one case has the id ${firstRepeated}, in ${files}`);
}

/**
 * Lists the cases of `files`, one listing child per file on `runtime`, in file order.
 *
 * @param files - The benchmark files, as absolute paths.
 * @param runtime - The runtime the listing children run on.
 * @param input - The options, the working directory, the stop signal and the child starter.
 * @returns The cases in file order, or `undefined` when the stop signal fired.
 * @throws {@link ListingError} When a listing child fails or gives no listing.
 */
async function listFiles(
  files: readonly string[],
  runtime: FoundRuntime,
  input: SelectInput,
): Promise<SelectedCase[] | undefined> {
  const { options, cwd, signal, startChild = realStartChild } = input;
  const cases: SelectedCase[] = [];
  for (const path of files) {
    if (signal?.aborted === true) return undefined;
    const file = slashed(relative(cwd, path));
    const outcome = await startChild(
      runtime,
      { mode: "list", file: path },
      { timeout: options.timeout, nodeImport: options.nodeImport?.resolved, signal },
    );
    if (outcome.status === "stopped") return undefined;
    if (outcome.status === "failed") throw new ListingError(file, outcome.error, outcome.output);
    if (!("cases" in outcome.result)) {
      const error = { phase: "child", message: "the child gave no listing", stack: null } as const;
      throw new ListingError(file, error, outcome.output);
    }
    for (const listed of outcome.result.cases) cases.push({ ...listed, path, file });
  }
  return cases;
}

/**
 * Selects the cases a run measures. Every runtime is looked up before any listing child starts.
 *
 * @param input - The options, the positional files, the working directory, the stop signal, and
 *   the functions that look a runtime up and start a child, the real ones by default.
 * @returns The runtimes with their versions and the selected cases, or a stop when the signal fired
 *   during listing.
 * @throws {ConfigError} When an argument matches no file, a runtime cannot be found, a listing
 *   child fails (a {@link ListingError}), two cases share an id, or no case is selected.
 */
export async function selectCases(input: SelectInput): Promise<Selection> {
  const { options, files, cwd, findRuntime = realFindRuntime } = input;
  const found = benchmarkFiles(options, files, cwd);
  const runtimes = await Promise.all(options.runtimes.map(async (runtime) => findRuntime(runtime)));
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
