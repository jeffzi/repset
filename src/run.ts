/**
 * A run: the results of each case's children, the judged entry of each contest, and the report
 * that holds them.
 */
import { readFile } from "node:fs/promises";
import { cpus as realCpus } from "node:os";
import { fileURLToPath } from "node:url";

import type { ChildError, MeasureRequest } from "./child.js";
import type { FoundRuntime } from "./children.js";
import { quantile } from "./measure/measure.js";
import type { Runtime } from "./measure/runtime.js";
import type { ResolvedOptions } from "./options.js";
import type {
  Contest,
  ContestPair,
  FailedResult,
  Machine,
  MeasuredProcess,
  MeasuredResult,
  Report,
  ReportOptions,
  Result,
  ResultBase,
} from "./report.js";
import { drawRandomSeed, type OnceInput, type StartHandlers, startEach } from "./schedule.js";
import type { SelectedCase } from "./select.js";
import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "./signed-rank.js";
import { property, valueAt } from "./utils.js";

// ---------------------------------------------------------------------------
// Run inputs and results
// ---------------------------------------------------------------------------

/**
 * The package's own `package.json`: one directory above this module, which holds from `src/` and
 * from `dist/` alike.
 */
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

export interface RunInput extends OnceInput {
  /**
   * Receives each result when it finishes, before the next child starts, with the entries of the
   * contests finished so far: a contest's entry comes with its last result.
   */
  readonly onResult?: ((result: Result, contests: readonly Contest[]) => void) | undefined;
  /**
   * Receives the number of planned measuring children that will no longer start when a contender
   * fails: the rounds of its contest still to come on that runtime.
   */
  readonly onDropped?: ((count: number) => void) | undefined;
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
  /** Draws the seed of the round orders when the run starts; a random 32-bit integer by default. */
  readonly drawSeed?: (() => number) | undefined;
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

/** What the process of a failed child did not reach. */
const NOTHING_MEASURED = {
  stats: null,
  sampling: null,
  checks: null,
  gc: null,
  rawSamples: null,
} as const;

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
 * What every result of a case holds, whether it was measured or failed.
 *
 * @param selected - The case.
 * @param runtime - The runtime its children ran on.
 * @returns Its id, name, contender, parameters, file, runtime and whether it set up per call.
 */
function resultBase(selected: SelectedCase, runtime: FoundRuntime): ResultBase {
  return {
    id: selected.id,
    name: selected.name,
    contender: selected.contender,
    params: {},
    file: selected.file,
    runtime: { name: runtime.runtime, version: runtime.version },
    setupPerCall: selected.setupPerCall,
  };
}

// ---------------------------------------------------------------------------
// Contest judging
// ---------------------------------------------------------------------------

/** The significance level of a contest's family of pairs. */
const ALPHA = 0.05;

/** How many timer resolutions per call a pair's ratio must clear past 1 to tell its contenders apart. */
const RESOLUTIONS = 1.25;

/** Two contenders of a contest, the signed-rank test of their rounds, and whom it proves faster. */
interface Verdict {
  readonly a: MeasuredResult;
  readonly b: MeasuredResult;
  readonly p: number;
  readonly pAdjusted: number;
  readonly faster: MeasuredResult | null;
}

/** The per-round `ln(median_b / median_a)` over the rounds both contenders ran. */
function logRatios(a: MeasuredResult, b: MeasuredResult): number[] {
  const medians = new Map(a.processes.map((process) => [process.round, process.stats.median]));
  return b.processes.flatMap((process) => {
    const median = medians.get(process.round);
    return median === undefined ? [] : [Math.log(process.stats.median / median)];
  });
}

/** The largest timer resolution per call among both contenders' processes, over the smaller median. */
function resolutionPerCall(a: MeasuredResult, b: MeasuredResult): number {
  const perCall = [...a.processes, ...b.processes].map(
    ({ sampling }) => sampling.timerResolutionNs / sampling.callsPerSample,
  );
  return Math.max(...perCall) / Math.min(a.median, b.median);
}

/**
 * Tests every pair of `measured`, adjusting the p values by Holm's over all of them.
 *
 * @param measured - The contenders that never failed.
 * @returns A verdict per pair; a pair is proven when its adjusted p is at most `ALPHA` and its
 *   ratio clears 1 by more than `RESOLUTIONS` timer resolutions per call.
 */
function verdictsOf(measured: readonly MeasuredResult[]): Verdict[] {
  const tested = measured.flatMap((a, index) =>
    measured.slice(index + 1).map((b) => {
      const differences = logRatios(a, b);
      return { a, b, p: signedRankP(differences), estimate: hodgesLehmann(differences) };
    }),
  );
  const adjusted = holm(tested.map(({ p }) => p));
  return tested.map(({ a, b, p, estimate }, index) => {
    const pAdjusted = valueAt(adjusted, index);
    const proven =
      pAdjusted <= ALPHA &&
      Math.exp(Math.abs(estimate)) - 1 > RESOLUTIONS * resolutionPerCall(a, b);
    const winner = estimate > 0 ? a : b;
    return { a, b, p, pAdjusted, faster: proven ? winner : null };
  });
}

/**
 * The pair of a verdict, `a` the earlier contender in `order`.
 *
 * @param verdict - The verdict.
 * @param order - The contest's contenders that never failed, sorted.
 * @param level - The interval's confidence level.
 * @returns The pair's ratio, interval and verdict.
 */
function pairOf(verdict: Verdict, order: readonly MeasuredResult[], level: number): ContestPair {
  const [a, b] =
    order.indexOf(verdict.a) < order.indexOf(verdict.b)
      ? [verdict.a, verdict.b]
      : [verdict.b, verdict.a];
  const differences = logRatios(a, b);
  const [low, high] = signedRankInterval(differences, level);
  return {
    a: a.id,
    b: b.id,
    ratio: Math.exp(hodgesLehmann(differences)),
    interval: [Math.exp(low), Math.exp(high)],
    p: verdict.p,
    pAdjusted: verdict.pAdjusted,
    faster: verdict.faster?.id ?? null,
  };
}

/**
 * Judges a contest from its contenders' results. A contest left with fewer than two contenders
 * that never failed, or whose rounds `n` fail `2 / 2ⁿ ≤ 0.05 / pairs`, is not judged: its entry
 * holds the medians and no rank, ratio or pair.
 *
 * @param results - The contest's results on one runtime, in the order they were emitted.
 * @returns The contest's entry.
 */
function contestOf(results: readonly [Result, ...Result[]]): Contest {
  const [{ name, runtime }] = results;
  const rounds = Math.max(
    ...results.flatMap(({ processes }) => processes.map(({ round }) => round)),
  );
  const measured = results.filter((result): result is MeasuredResult => result.status === "ok");
  const failed = results
    .filter((result): result is FailedResult => result.status === "failed")
    .map(({ id }) => ({ id, median: null, ratio: null, rank: null }));
  const pairCount = (measured.length * (measured.length - 1)) / 2;
  const head = { name, params: {}, runtime, rounds };
  if (measured.length < 2 || 2 / 2 ** rounds > ALPHA / pairCount) {
    const contenders = measured
      .toSorted((left, right) => left.median - right.median)
      .map(({ id, median }) => ({ id, median, ratio: null, rank: null }));
    return { ...head, contenders: [...contenders, ...failed], pairs: [] };
  }
  const verdicts = verdictsOf(measured);
  const rankOf = (result: MeasuredResult): number =>
    1 +
    verdicts.filter(
      ({ a, b, faster }) => (a === result || b === result) && faster !== null && faster !== result,
    ).length;
  const ranked = measured
    .map((result) => ({ result, rank: rankOf(result) }))
    .toSorted((left, right) =>
      left.rank === right.rank ? left.result.median - right.result.median : left.rank - right.rank,
    );
  const order = ranked.map(({ result }) => result);
  const position = (id: string): number => order.findIndex((result) => result.id === id);
  const pairs = verdicts
    .map((verdict) => pairOf(verdict, order, 1 - ALPHA / pairCount))
    .toSorted((left, right) =>
      left.a === right.a
        ? position(left.b) - position(right.b)
        : position(left.a) - position(right.a),
    );
  const [fastest] = order;
  const contenders = ranked.map(({ result, rank }) => ({
    id: result.id,
    median: result.median,
    ratio:
      result === fastest
        ? 1
        : (pairs.find((pair) => pair.a === fastest?.id && pair.b === result.id)?.ratio ?? null),
    rank,
  }));
  return { ...head, contenders: [...contenders, ...failed], pairs };
}

// ---------------------------------------------------------------------------
// Results and runs
// ---------------------------------------------------------------------------

/**
 * The result of a case whose every process measured, its median the median of theirs.
 *
 * @param selected - The case.
 * @param runtime - The runtime its children ran on.
 * @param processes - Its processes, in run order.
 * @returns The measured result.
 */
function measuredResult(
  selected: SelectedCase,
  runtime: FoundRuntime,
  processes: readonly [MeasuredProcess, ...MeasuredProcess[]],
): MeasuredResult {
  const medians = processes.map((process) => process.stats.median).toSorted((a, b) => a - b);
  const median = quantile(medians, 0.5);
  return { ...resultBase(selected, runtime), status: "ok", error: null, median, processes };
}

/**
 * The handlers that turn measuring children into results: a case gathers one process per round;
 * a failed child finishes its case at once, and the rest finish when their group's last round
 * ends. A contest's entry is recorded just before its last result is emitted: the last survivor's
 * when its last round ends, or the last failure's when no contender is left running. A group the
 * stop signal ends gives no further result and no entry.
 *
 * @param emit - Receives each result as it finishes.
 * @param record - Receives each contest's entry as it finishes.
 * @returns The handlers of each child's outcome and of each group's end.
 */
function resultHandlers(
  emit: (result: Result) => void,
  record: (contest: Contest) => void,
): Pick<StartHandlers<"measure">, "finished" | "ended"> {
  const ran = new Map<SelectedCase, MeasuredProcess[]>();
  const failed = new Map<SelectedCase, FailedResult>();
  const takeFailures = (group: readonly SelectedCase[]): FailedResult[] =>
    [...failed].flatMap(([selected, result]) => {
      if (!group.includes(selected)) return [];
      failed.delete(selected);
      return [result];
    });
  return {
    finished: ({ runtime, selected, group, outcome, round, orderInRound }) => {
      const processes = ran.get(selected) ?? [];
      if (outcome.status === "ok") {
        const { stats, sampling, checks, gc } = outcome.result;
        const measuring = { round, orderInRound, stats, sampling, checks, gc, rawSamples: null };
        ran.set(selected, [...processes, measuring]);
        return;
      }
      ran.delete(selected);
      const { phase, message, stack, teardownError } = outcome.error;
      const error = { phase, message, stack, teardownError, output: outcome.output };
      const failing = { round, orderInRound, ...NOTHING_MEASURED };
      const result: FailedResult = {
        ...resultBase(selected, runtime),
        status: "failed",
        error,
        median: null,
        processes: [...processes, failing],
      };
      if (group.length > 1 && group.every((member) => member === selected || failed.has(member))) {
        const [first, ...rest] = [...takeFailures(group), result];
        record(contestOf([first, ...rest]));
      } else {
        failed.set(selected, result);
      }
      emit(result);
    },
    ended: (runtime, group) => {
      const finished = group.flatMap((selected) => {
        const [first, ...rest] = ran.get(selected) ?? [];
        ran.delete(selected);
        return first === undefined ? [] : [measuredResult(selected, runtime, [first, ...rest])];
      });
      const [first, ...rest] = [...takeFailures(group), ...finished];
      for (const result of finished.slice(0, -1)) emit(result);
      if (group.length > 1 && first !== undefined) record(contestOf([first, ...rest]));
      const last = finished.at(-1);
      if (last !== undefined) emit(last);
    },
  };
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
 * @param seed - The seed of the round orders, `null` when the run holds no contest.
 * @returns The report's options.
 */
function reportOptions(
  input: OnceInput,
  options: ResolvedOptions,
  seed: number | null,
): ReportOptions {
  return {
    runtimes: options.runtimes,
    files: input.files === undefined || input.files.length === 0 ? null : [...input.files],
    filter: input.filter ?? null,
    minTime: options.minTime,
    minSamples: options.minSamples,
    rounds: options.rounds ?? null,
    seed,
    timeout: options.timeout,
    nodeImport: options.nodeImport?.written ?? null,
    rawSamples: false,
  };
}

/**
 * Runs a benchmark run: resolves the options, selects the cases, then measures each selected case
 * on each runtime in its own child, one at a time, and each contest in rounds of one child per
 * contender. It never prints.
 *
 * A failed case is a result with an `error`, never a throw, and does not stop the run. A plain
 * case's result is emitted when its child ends, a failed contender's when its failing child ends,
 * and the other contenders' when their contest's last round ends. When the stop signal fires, the
 * running child is killed, its case and the unfinished contenders of its contest get no result,
 * and no further child starts.
 *
 * @param input - The caller's options, the positional files, the stop signal, the result,
 *   selection, plan and dropped-children callbacks, the calls per sample to fix, and the functions that look a
 *   runtime up, start a child, list the CPUs, draw the seed and name the `package.json` to read
 *   the version from, the real ones by default.
 * @returns The report of the results that finished, with `interrupted` set when the stop signal
 *   ended the run.
 * @throws {@link Error} The error reading the package's `package.json`, before any child starts;
 *   what `onSelected` or `onPlanned` throws, before the first child of its phase starts; what
 *   `onResult` or `onDropped` throws, once a child has finished; or what starting a child throws.
 * @throws `ConfigError` When the options are invalid or the selection fails, before any
 *   measuring child starts.
 */
export async function run(input: RunInput): Promise<Report> {
  const startedAt = new Date().toISOString();
  const repset = await packageVersion(input.packageJson);
  const machine = machineOf(input.cpus ?? realCpus);
  const seed = (input.drawSeed ?? drawRandomSeed)();
  const results: Result[] = [];
  const contests: Contest[] = [];
  let contested = false;
  const { callsPerSample } = input;
  const reportOf = (options: ResolvedOptions, interrupted: boolean): Report => ({
    schema: 1,
    repset,
    startedAt,
    interrupted,
    options: reportOptions(input, options, contested ? seed : null),
    machine,
    results: [...results],
    contests: [...contests],
  });
  const emit = (result: Result): void => {
    results.push(result);
    input.onResult?.(result, [...contests]);
  };
  const record = (contest: Contest): void => {
    contests.push(contest);
  };
  const { options, interrupted } = await startEach<MeasureRequest>(
    input,
    (resolved, selected) => ({
      mode: "measure",
      file: selected.path,
      id: selected.id,
      minTime: resolved.minTime,
      minSamples: resolved.minSamples,
      ...(callsPerSample === undefined ? {} : { callsPerSample }),
    }),
    {
      passed: (resolved, total, formed) => {
        contested = formed;
        input.onSelected?.(reportOf(resolved, false));
        input.onPlanned?.(total);
      },
      dropped: input.onDropped,
      ...resultHandlers(emit, record),
    },
    seed,
  );
  return reportOf(options, interrupted);
}

/**
 * Runs every selected case once per runtime, each in its own child, with no timing, one at a time
 * in selection order; a contest's contenders run once each, forming no rounds. A failed case does
 * not stop it.
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
    {
      passed: (_options, total) => input.onPlanned?.(total),
      finished: ({ runtime, selected, outcome }) => {
        const ran = { id: selected.id, runtime: runtime.runtime };
        if (outcome.status === "ok") {
          results.push({ ...ran, status: "ok" });
        } else {
          const { phase, message, teardownError } = outcome.error;
          results.push({ ...ran, status: "failed", error: { phase, message, teardownError } });
        }
      },
    },
  );
  return { interrupted, results };
}
