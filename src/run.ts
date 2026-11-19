/**
 * A run: selecting the cases (finding the benchmark files, looking up the runtimes, and listing
 * each file's cases in a child), then starting one child per case and runtime to measure the case
 * or run it once.
 */
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus as realCpus } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChildError, ChildRequest } from "./child.js";
import {
  findRuntime as realFindRuntime,
  type FoundRuntime,
  type Outcome,
  startChild as realStartChild,
  type StartOptions,
} from "./children.js";
import type { Runtime } from "./measure/runtime.js";
import {
  ConfigError,
  isFile,
  type OptionsInput,
  resolveOptions,
  type ResolvedOptions,
} from "./options.js";
import type { FailedProcess, Machine, Report, ReportOptions, Result } from "./report.js";
import { property } from "./utils.js";

// ---------------------------------------------------------------------------
// Case selection
// ---------------------------------------------------------------------------

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
function startOptions(options: ResolvedOptions, signal: AbortSignal | undefined): StartOptions {
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
    for (const listed of outcome.result.cases) cases.push({ ...listed, path, file });
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

// ---------------------------------------------------------------------------
// Run inputs and results
// ---------------------------------------------------------------------------

/**
 * The package's own `package.json`: one directory above this module, which holds from `src/` and
 * from `dist/` alike.
 */
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

export interface OnceInput extends OptionsInput, ChildFunctionOverrides {
  /** Paths or globs of benchmark files, relative to `cwd`; when there are some, they replace `include`. */
  readonly files?: readonly string[] | undefined;
  /** Kills the running child and starts no further one when it fires. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Receives the number of children each phase will start, before that phase's first child starts:
   * the benchmark files to list, then the cases times the runtimes to measure or run once.
   */
  readonly onPlanned?: ((total: number) => void) | undefined;
}

export interface RunInput extends OnceInput {
  /** Receives each result when it finishes, before the next child starts. */
  readonly onResult?: ((result: Result) => void) | undefined;
  /**
   * Receives the report with no result once listing has passed, before the first measuring child
   * starts; what it throws ends the run with no measuring child started.
   */
  readonly onSelected?: ((report: Report) => void) | undefined;
  /** Lists the host's logical CPUs; `os.cpus` by default. */
  readonly cpus?: (() => readonly { readonly model: string }[]) | undefined;
  /** The calls per sample every measuring child times its case at; absent means each calibrates one. */
  readonly callsPerSample?: number | undefined;
  /** The `package.json` whose version the report records; the package's own by default. */
  readonly packageJson?: string | undefined;
}

/** One case's once run on one runtime: it ran, or it failed in a phase. */
export type OnceResult =
  | { readonly id: string; readonly runtime: Runtime; readonly status: "ok" }
  | {
      readonly id: string;
      readonly runtime: Runtime;
      readonly status: "failed";
      readonly error: Pick<ChildError, "phase" | "message" | "teardownError">;
    };

export interface OnceRun {
  readonly interrupted: boolean;
  readonly results: readonly OnceResult[];
}

/** How a child asked for `M` ended when the caller did not stop it. */
type Finished<M extends ChildRequest["mode"]> = Exclude<Outcome<M>, { status: "stopped" }>;

/** The processes of a case whose child failed: one, holding `null` for what it did not reach. */
const FAILED_PROCESSES: readonly [FailedProcess] = [
  {
    round: 1,
    orderInRound: 1,
    stats: null,
    sampling: null,
    checks: null,
    gc: null,
    rawSamples: null,
  },
];

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Reads the `version` string of a `package.json`, rejecting a file that holds none.
 *
 * @param path - The `package.json` to read; the package's own by default.
 * @returns Its `version`.
 * @throws {@link Error} The read or parse error as it is, or a plain `Error` when the file holds no
 *   version string.
 */
export async function packageVersion(path: string = PACKAGE_JSON): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const version = property(parsed, "version");
  if (typeof version !== "string") throw new Error(`${path} holds no version string`);
  return version;
}

/**
 * Resolves the caller's options, selects the cases, then starts one child per selected case per
 * runtime, one at a time: runtime by runtime in the selection's order, cases in selection order.
 *
 * @param input - The caller's options, the positional files, the stop signal, the plan callback
 *   and the child functions.
 * @param request - The request of one case's child, from the resolved options.
 * @param finished - Receives each child's outcome before the next child starts.
 * @param passed - Called with the resolved options and the number of children the cases will
 *   start once the selection passed, before the first child of a case starts.
 * @returns The resolved options, and whether the stop signal ended the run before every child ran:
 *   during listing, before the next child, or by stopping the running one.
 * @throws {@link ConfigError} When the options are invalid or the selection fails, before any child
 *   but the listing children starts.
 * @throws {@link Error} What the plan callback, `passed` or `finished` throws, or what starting a
 *   child throws.
 */
async function startEach<R extends ChildRequest>(
  input: OnceInput,
  request: (options: ResolvedOptions, selected: SelectedCase) => R,
  finished: (runtime: FoundRuntime, selected: SelectedCase, outcome: Finished<R["mode"]>) => void,
  passed: (options: ResolvedOptions, total: number) => void,
): Promise<{ options: ResolvedOptions; interrupted: boolean }> {
  const options = await resolveOptions(input);
  const { signal, startChild = realStartChild } = input;
  const selection = await selectCases({
    options,
    files: input.files ?? [],
    cwd: input.cwd,
    signal,
    findRuntime: input.findRuntime,
    startChild,
    onPlanned: input.onPlanned,
  });
  if (selection.status === "stopped") return { options, interrupted: true };
  passed(options, selection.runtimes.length * selection.cases.length);
  const childOptions = startOptions(options, signal);
  for (const runtime of selection.runtimes) {
    for (const selected of selection.cases) {
      if (signal?.aborted === true) return { options, interrupted: true };
      const outcome = await startChild(runtime, request(options, selected), childOptions);
      if (outcome.status === "stopped") return { options, interrupted: true };
      finished(runtime, selected, outcome);
    }
  }
  return { options, interrupted: false };
}

/**
 * Turns a measuring child's outcome into the case's report result.
 *
 * @param selected - The case.
 * @param runtime - The runtime its child ran on.
 * @param outcome - How its measuring child ended.
 * @returns A measured result when the child measured the case, a failed one otherwise.
 */
function resultOf(
  selected: SelectedCase,
  runtime: FoundRuntime,
  outcome: Finished<"measure">,
): Result {
  const base = {
    id: selected.id,
    name: selected.id,
    contender: null,
    params: {},
    file: selected.file,
    runtime: { name: runtime.runtime, version: runtime.version },
    setupPerCall: selected.setupPerCall,
  };
  if (outcome.status === "ok") {
    const { stats, sampling, checks, gc } = outcome.result;
    const measuring = { round: 1, orderInRound: 1, stats, sampling, checks, gc, rawSamples: null };
    return { ...base, status: "ok", error: null, median: stats.median, processes: [measuring] };
  }
  const { phase, message, stack, teardownError } = outcome.error;
  const error = { phase, message, stack, teardownError, output: outcome.output };
  return { ...base, status: "failed", error, median: null, processes: FAILED_PROCESSES };
}

/**
 * Describes the host; `cpu` and `cores` are `null` when `cpus` lists none.
 *
 * @param cpus - Lists the host's logical CPUs.
 * @returns The OS, the architecture, the first CPU's model and the CPU count.
 */
function machineOf(cpus: () => readonly { readonly model: string }[]): Machine {
  const listed = cpus();
  return {
    os: process.platform,
    arch: process.arch,
    cpu: listed[0]?.model ?? null,
    cores: listed.length === 0 ? null : listed.length,
  };
}

/**
 * The options the report records: the merged values, with `files`, `filter` and `nodeImport` as
 * the caller or the config file wrote them.
 *
 * @param input - The caller's options.
 * @param options - The resolved options.
 * @returns The report's options.
 */
function reportOptions(input: OnceInput, options: ResolvedOptions): ReportOptions {
  return {
    runtimes: options.runtimes,
    files: input.files === undefined || input.files.length === 0 ? null : [...input.files],
    filter: input.filter ?? null,
    minTime: options.minTime,
    minSamples: options.minSamples,
    rounds: null,
    seed: null,
    timeout: options.timeout,
    nodeImport: options.nodeImport?.written ?? null,
    rawSamples: false,
  };
}

/**
 * Runs a benchmark run: resolves the options, selects the cases, then measures each selected case
 * on each runtime in its own child, one at a time. It never prints.
 *
 * A failed case is a result with an `error`, never a throw, and does not stop the run. When the
 * stop signal fires, the running child is killed, its case gets no result, and no further child
 * starts.
 *
 * @param input - The caller's options, the positional files, the stop signal, the result,
 *   selection and plan callbacks, the calls per sample to fix, and the functions that look a
 *   runtime up, start a child, list the CPUs and name the `package.json` to read the version from,
 *   the real ones by default.
 * @returns The report of the results that finished, with `interrupted` set when the stop signal
 *   ended the run.
 * @throws {@link Error} The error reading the package's `package.json`, before any child starts;
 *   what `onSelected` or `onPlanned` throws, before the first child of its phase starts; what
 *   `onResult` throws, once a child has finished; or what starting a child throws.
 * @throws {@link ConfigError} When the options are invalid or the selection fails, before any
 *   measuring child starts.
 */
export async function run(input: RunInput): Promise<Report> {
  const startedAt = new Date().toISOString();
  const repset = await packageVersion(input.packageJson);
  const machine = machineOf(input.cpus ?? realCpus);
  const results: Result[] = [];
  const { callsPerSample } = input;
  const reportOf = (options: ResolvedOptions, interrupted: boolean): Report => ({
    schema: 1,
    repset,
    startedAt,
    interrupted,
    options: reportOptions(input, options),
    machine,
    results: [...results],
    contests: [],
  });
  const { options, interrupted } = await startEach(
    input,
    (resolved, selected) => ({
      mode: "measure",
      file: selected.path,
      id: selected.id,
      minTime: resolved.minTime,
      minSamples: resolved.minSamples,
      ...(callsPerSample === undefined ? {} : { callsPerSample }),
    }),
    (runtime, selected, outcome) => {
      const result = resultOf(selected, runtime, outcome);
      results.push(result);
      input.onResult?.(result);
    },
    (resolved, total) => {
      input.onSelected?.(reportOf(resolved, false));
      input.onPlanned?.(total);
    },
  );
  return reportOf(options, interrupted);
}

/**
 * Runs every selected case once per runtime, each in its own child, with no timing, one at a time
 * in the order a run measures them. A failed case does not stop it.
 *
 * @param input - The caller's options, the positional files, the stop signal, the plan callback,
 *   and the functions that look a runtime up and start a child, the real ones by default.
 * @returns Per case and runtime, that it ran or how it failed, with `interrupted` set when the stop
 *   signal ended it.
 * @throws {@link ConfigError} When the options are invalid or the selection fails, before any once
 *   child starts.
 * @throws {@link Error} What `onPlanned` throws, before the first child of its phase starts, or
 *   what starting a child throws.
 */
export async function runOnce(input: OnceInput): Promise<OnceRun> {
  const results: OnceResult[] = [];
  const { interrupted } = await startEach(
    input,
    (_options, selected) => ({ mode: "once", file: selected.path, id: selected.id }),
    (runtime, selected, outcome) => {
      const ran = { id: selected.id, runtime: runtime.runtime };
      if (outcome.status === "ok") {
        results.push({ ...ran, status: "ok" });
      } else {
        const { phase, message, teardownError } = outcome.error;
        results.push({ ...ran, status: "failed", error: { phase, message, teardownError } });
      }
    },
    (_options, total) => input.onPlanned?.(total),
  );
  return { interrupted, results };
}
