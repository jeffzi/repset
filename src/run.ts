/**
 * A run: one child per selected case and runtime, measuring the case or running it once; and the
 * exact signed-rank statistics that judge a contest's pairs.
 */
import { readFile } from "node:fs/promises";
import { cpus as realCpus } from "node:os";
import { fileURLToPath } from "node:url";

import type { ChildError, ChildRequest } from "./child.js";
import { type FoundRuntime, type Outcome, startChild as realStartChild } from "./children.js";
import type { Runtime } from "./measure/runtime.js";
import { type OptionsInput, resolveOptions, type ResolvedOptions } from "./options.js";
import type { FailedProcess, Machine, Report, ReportOptions, Result } from "./report.js";
import {
  type ChildFunctionOverrides,
  type SelectedCase,
  selectCases,
  startOptions,
} from "./select.js";
import { property, valueAt } from "./utils.js";

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
 * @throws `ConfigError` When the options are invalid or the selection fails, before any child
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
 * @throws `ConfigError` When the options are invalid or the selection fails, before any
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
 * @throws `ConfigError` When the options are invalid or the selection fails, before any once
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

// ---------------------------------------------------------------------------
// Signed-rank statistics
// ---------------------------------------------------------------------------

/** Past this many weights, a null count could exceed 2^53 and stop being exact in a double. */
const EXACT_COUNTS = 53;

/**
 * The null distribution of the sum of the positive weights when each weight's sign is a fair coin
 * flip. Up to 53 weights `mass` holds integer counts of sign assignments over a `total` of 2^n,
 * exact in a double; past that it holds probabilities over a `total` of 1.
 *
 * @param weights - Nonnegative integer weights.
 * @returns `mass[t]` over `total` is the probability that the positive weights sum to `t`.
 */
function nullDistribution(weights: readonly number[]): { mass: number[]; total: number } {
  const exact = weights.length <= EXACT_COUNTS;
  let mass = [1];
  for (const weight of weights) {
    const share = mass.map((count) => (exact ? count : count / 2));
    const next = [...share, ...Array.from({ length: weight }, () => 0)];
    for (const [sum, count] of share.entries())
      next[sum + weight] = valueAt(next, sum + weight) + count;
    mass = next;
  }
  return { mass, total: exact ? 2 ** weights.length : 1 };
}

/**
 * Ranks magnitudes from 1, equal magnitudes sharing their average rank, then doubles every rank so
 * an average of two ranks stays an integer.
 *
 * @param magnitudes - The magnitudes to rank.
 * @returns Each magnitude's doubled rank, in the input's order.
 */
function doubledRanks(magnitudes: readonly number[]): number[] {
  const order = [...magnitudes.keys()].toSorted(
    (left, right) => valueAt(magnitudes, left) - valueAt(magnitudes, right),
  );
  const ranks = magnitudes.map(() => 0);
  let start = 0;
  while (start < order.length) {
    const magnitude = valueAt(magnitudes, valueAt(order, start));
    let end = start;
    while (end + 1 < order.length && valueAt(magnitudes, valueAt(order, end + 1)) === magnitude) {
      end += 1;
    }
    for (let position = start; position <= end; position += 1) {
      ranks[valueAt(order, position)] = start + end + 2;
    }
    start = end + 1;
  }
  return ranks;
}

/**
 * The two-sided exact signed-rank p value. Zero differences are dropped, and equal magnitudes
 * share their average rank; the null distribution is the exact one of those ranks.
 *
 * @param differences - The paired differences.
 * @returns The p value, 1 when no difference is nonzero.
 */
export function signedRankP(differences: readonly number[]): number {
  const nonzero = differences.filter((difference) => difference !== 0);
  if (nonzero.length === 0) return 1;
  const ranks = doubledRanks(nonzero.map((difference) => Math.abs(difference)));
  const observed = ranks.reduce(
    (sum, rank, index) => (valueAt(nonzero, index) > 0 ? sum + rank : sum),
    0,
  );
  const { mass, total } = nullDistribution(ranks);
  let lower = 0;
  let upper = 0;
  for (const [sum, count] of mass.entries()) {
    if (sum <= observed) lower += count;
    if (sum >= observed) upper += count;
  }
  return Math.min(1, (2 * Math.min(lower, upper)) / total);
}

/** The Walsh averages `(d_i + d_j) / 2`, `i ≤ j`, of `differences`, ascending. */
function walshAverages(differences: readonly number[]): number[] {
  const averages: number[] = [];
  for (const [index, left] of differences.entries()) {
    for (const right of differences.slice(index)) averages.push((left + right) / 2);
  }
  return averages.toSorted((left, right) => left - right);
}

/**
 * The Hodges–Lehmann estimate: the median of the Walsh averages of every difference, zeros
 * included.
 *
 * @param differences - The paired differences.
 * @returns The estimate.
 * @throws RangeError When `differences` is empty.
 */
export function hodgesLehmann(differences: readonly number[]): number {
  const averages = walshAverages(differences);
  const middle = averages.length - 1;
  return (valueAt(averages, Math.floor(middle / 2)) + valueAt(averages, Math.ceil(middle / 2))) / 2;
}

/**
 * The exact confidence interval of the Hodges–Lehmann estimate: the Walsh averages of rank `C` and
 * `M + 1 − C` among the `M` of every difference, zeros included, where `C` is the largest count
 * with `2 · P(T ≤ C − 1) ≤ 1 − level` under the untied null of the signed-rank statistic `T` for
 * that many differences. Tied magnitudes keep the untied null.
 *
 * @param differences - The paired differences.
 * @param level - The confidence level, as 0.95 for 95%.
 * @returns The interval's low and high ends.
 * @throws RangeError When no Walsh average reaches `level`: too few differences for it.
 */
export function signedRankInterval(
  differences: readonly number[],
  level: number,
): readonly [number, number] {
  const { mass, total } = nullDistribution(Array.from(differences, (_, index) => index + 1));
  let critical = 0;
  let cumulative = 0;
  for (const count of mass) {
    cumulative += count;
    if ((2 * cumulative) / total > 1 - level) break;
    critical += 1;
  }
  if (critical === 0) {
    throw new RangeError(
      `no interval reaches level ${level} with ${differences.length} differences`,
    );
  }
  const averages = walshAverages(differences);
  return [valueAt(averages, critical - 1), valueAt(averages, averages.length - critical)];
}

/**
 * Holm's adjusted p values: over the raw p values in ascending order, each one times the count of
 * p values from it to the largest, raised to the largest adjusted value before it and capped at 1.
 *
 * @param pValues - The raw p values of one family.
 * @returns The adjusted p values, in the input's order.
 */
export function holm(pValues: readonly number[]): number[] {
  const ordered = [...pValues.keys()].toSorted(
    (left, right) => valueAt(pValues, left) - valueAt(pValues, right),
  );
  const adjusted = pValues.map(() => 1);
  let running = 0;
  for (const [step, index] of ordered.entries()) {
    const scaled = Math.min(1, (pValues.length - step) * valueAt(pValues, index));
    running = Math.max(running, scaled);
    adjusted[index] = running;
  }
  return adjusted;
}
