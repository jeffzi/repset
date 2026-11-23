/**
 * A run: the results of each case's children, the judged entry of each contest, and the report
 * that holds them.
 */
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus as realCpus } from "node:os";
import { fileURLToPath } from "node:url";

import type { ChildError, MeasureRequest } from "./child.js";
import type { FoundRuntime } from "./children.js";
import type { Runtime } from "./measure/runtime.js";
import type { ResolvedOptions } from "./options.js";
import type {
  CaseMeasurement,
  Contest,
  ContestPair,
  FailedResult,
  HeadlineTime,
  Host,
  MeasuredResult,
  Report,
  ReportOptions,
  Result,
  ResultBase,
} from "./report.js";
import { ALPHA, isContest, type OnceInput, type StartHandlers, startEach } from "./schedule.js";
import type { SelectedCase } from "./select.js";
import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "./signed-rank.js";
import { pairsOf, property, quantile, valueAt } from "./utils.js";

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
   * fails: the repetitions of its contest still to come on that runtime.
   */
  readonly onDropped?: ((count: number) => void) | undefined;
  /**
   * Receives the report with no result once listing has passed, with the cases of each contest
   * that formed, scheduled the same on every runtime, before the first measuring child starts; what
   * it throws ends the run with no measuring child started.
   */
  readonly onSelected?:
    | ((report: Report, contests: readonly (readonly SelectedCase[])[]) => void)
    | undefined;
  /** Lists the host's logical CPUs; `os.cpus` by default. */
  readonly cpus?: (() => readonly { readonly model: string }[]) | undefined;
  /** The calls per sample every measuring child times its case at; absent means each calibrates one. */
  readonly callsPerSample?: number | undefined;
  /** The `package.json` whose version the report records; the package's own by default. */
  readonly packageJson?: string | undefined;
  /** Draws the seed of the repetition orders when the run starts; a random 32-bit integer by default. */
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

// ---------------------------------------------------------------------------
// Report scaffolding
// ---------------------------------------------------------------------------

/**
 * Reads the `version` string of a `package.json`.
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
// Contest judgment
// ---------------------------------------------------------------------------

/** How many timer resolutions per call a pair's ratio must clear past 1 to tell its contenders apart. */
const RESOLUTIONS = 1.25;

/** Two contenders of a contest, the signed-rank test of their repetitions, and whom it proves faster. */
interface Verdict {
  readonly a: MeasuredResult;
  readonly b: MeasuredResult;
  readonly p: number;
  readonly pAdjusted: number;
  readonly faster: MeasuredResult | null;
  readonly tie: ContestPair["tie"];
}

/** The per-repetition `ln(median_b / median_a)` over the repetitions both contenders ran. */
function logRatios(a: MeasuredResult, b: MeasuredResult): number[] {
  const medians = new Map(
    a.measurements.map(({ repetition, time }) => [repetition, time.stats.median]),
  );
  return b.measurements.flatMap(({ repetition, time }) => {
    const median = medians.get(repetition);
    return median === undefined ? [] : [Math.log(time.stats.median / median)];
  });
}

/** The largest timer resolution per call among both contenders' measurements, over the smaller median. */
function resolutionPerCall(a: MeasuredResult, b: MeasuredResult): number {
  const perCall = [...a.measurements, ...b.measurements].map(
    ({ time: { sampling } }) => sampling.timerResolutionNs / sampling.callsPerSample,
  );
  return Math.max(...perCall) / Math.min(a.time.median, b.time.median);
}

/** Why a pair has no verdict, or `null` when it is proven; see `ContestPair.tie`. */
function tieOf(
  pAdjusted: number,
  estimate: number,
  a: MeasuredResult,
  b: MeasuredResult,
): ContestPair["tie"] {
  if (pAdjusted > ALPHA) return "repetitions";
  const withinTimer = Math.exp(Math.abs(estimate)) - 1 <= RESOLUTIONS * resolutionPerCall(a, b);
  return withinTimer ? "timer" : null;
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
    const tie = tieOf(pAdjusted, estimate, a, b);
    const winner = estimate > 0 ? a : b;
    return { a, b, p, pAdjusted, faster: tie === null ? winner : null, tie };
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
    tie: verdict.tie,
  };
}

/**
 * Judges a contest from its contenders' results. A contest left with fewer than two contenders
 * that never failed, or whose repetitions `n` fail `2 / 2ⁿ ≤ 0.05 / pairs`, is not judged: its
 * entry holds the times and no rank, ratio or pair.
 *
 * @param results - The contest's results on one runtime, in the order they were emitted.
 * @returns The contest's entry.
 */
function contestOf(results: readonly [Result, ...Result[]]): Contest {
  const [{ name, runtime }] = results;
  const repetitionCount = Math.max(
    ...results.flatMap(({ measurements }) =>
      measurements.flatMap(({ repetition }) => (repetition === null ? [] : [repetition])),
    ),
  );
  const measured = results.filter((result): result is MeasuredResult => result.status === "ok");
  const failed = results
    .filter((result): result is FailedResult => result.status === "failed")
    .map(({ id }) => ({ id, time: null, ratio: null, rank: null }));
  const pairCount = pairsOf(measured.length);
  const head = { name, params: {}, runtime, repetitionCount };
  const smallestP = 2 / 2 ** repetitionCount;
  const tooFewRepetitions = smallestP > ALPHA / pairCount;
  if (measured.length < 2 || tooFewRepetitions) {
    const contenders = measured
      .toSorted((left, right) => left.time.median - right.time.median)
      .map(({ id, time }) => ({ id, time, ratio: null, rank: null }));
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
      left.rank === right.rank
        ? left.result.time.median - right.result.time.median
        : left.rank - right.rank,
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
    time: result.time,
    ratio:
      result === fastest
        ? 1
        : (pairs.find((pair) => pair.a === fastest?.id && pair.b === result.id)?.ratio ?? null),
    rank,
  }));
  return { ...head, contenders: [...contenders, ...failed], pairs };
}

// ---------------------------------------------------------------------------
// Result handlers
// ---------------------------------------------------------------------------

/**
 * Reads the median of `values`, interpolated between the two middle values when their count is
 * even.
 *
 * @param values - The values, in any order; they are left as they are.
 * @returns The median.
 * @throws RangeError when `values` is empty.
 */
export function medianOf(values: readonly number[]): number {
  return quantile(
    values.toSorted((left, right) => left - right),
    0.5,
  );
}

/**
 * The result of a case whose every measuring child measured, its `time.median` the median of their
 * `time.stats.median`s.
 *
 * @param selected - The case.
 * @param runtime - The runtime its children ran on.
 * @param measurements - Its measurements, in run order.
 * @returns The measured result.
 */
function measuredResult(
  selected: SelectedCase,
  runtime: FoundRuntime,
  measurements: readonly [CaseMeasurement, ...CaseMeasurement[]],
): MeasuredResult {
  const time: HeadlineTime = {
    unit: "ns/call",
    median: medianOf(measurements.map((measurement) => measurement.time.stats.median)),
  };
  return { ...resultBase(selected, runtime), status: "ok", error: null, time, measurements };
}

/**
 * The handlers that turn measuring children into results: a case gathers one measurement per
 * repetition; a failed child finishes its case at once, and the rest finish when their group's last
 * repetition ends. A contest's entry is recorded just before its last result is emitted: the last
 * survivor's when its last repetition ends, or the last failure's when no contender is left
 * running. A group the stop signal ends gives no further result and no entry.
 *
 * @param emit - Receives each result as it finishes.
 * @param record - Receives each contest's entry as it finishes.
 * @param keepsGc - Tells whether the resolved `debug` option is on, asked for each child because
 *   the options resolve after these handlers are built; when it returns false, each measurement's
 *   `gc` is `null`.
 * @returns The handlers of each child's outcome and of each group's end.
 */
function resultHandlers(
  emit: (result: Result) => void,
  record: (contest: Contest) => void,
  keepsGc: () => boolean,
): Pick<StartHandlers<"measure">, "finished" | "ended"> {
  const ran = new Map<SelectedCase, CaseMeasurement[]>();
  const failed = new Map<SelectedCase, FailedResult>();
  const takeFailures = (group: readonly SelectedCase[]): FailedResult[] =>
    [...failed].flatMap(([selected, result]) => {
      if (!group.includes(selected)) return [];
      failed.delete(selected);
      return [result];
    });
  return {
    finished: ({ runtime, selected, group, outcome, repetition, orderInRepetition }) => {
      const measurements = ran.get(selected) ?? [];
      if (outcome.status === "ok") {
        const measured = outcome.result.time;
        const time = keepsGc() ? measured : { ...measured, gc: null };
        ran.set(selected, [...measurements, { repetition, orderInRepetition, time }]);
        return;
      }
      ran.delete(selected);
      const { phase, message, stack, teardownError } = outcome.error;
      const error = { phase, message, stack, teardownError, output: outcome.output };
      const result: FailedResult = {
        ...resultBase(selected, runtime),
        status: "failed",
        error,
        time: null,
        measurements: [...measurements, { repetition, orderInRepetition, time: null }],
      };
      const contestEnds =
        isContest(group) && group.every((member) => member === selected || failed.has(member));
      if (contestEnds) {
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
      if (isContest(group) && first !== undefined) record(contestOf([first, ...rest]));
      const last = finished.at(-1);
      if (last !== undefined) emit(last);
    },
  };
}

// ---------------------------------------------------------------------------
// Run entry points
// ---------------------------------------------------------------------------

/**
 * Describes the host.
 *
 * @param cpus - Lists the host's logical CPUs.
 * @returns The OS, the architecture, the first CPU's model and the CPU count; `cpu` and
 *   `coreCount` are `null` when `cpus` lists none.
 */
function hostOf(cpus: () => readonly { readonly model: string }[]): Host {
  const listed = cpus();
  return {
    os: process.platform,
    arch: process.arch,
    cpu: listed[0]?.model ?? null,
    coreCount: listed.length === 0 ? null : listed.length,
  };
}

/**
 * The options the report records: the merged values, with `files`, `filter` and `nodeImport` as
 * the caller or the config file wrote them.
 *
 * @param input - The caller's options.
 * @param options - The resolved options.
 * @param seed - The seed of the repetition orders, `null` when the run holds no contest.
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
    minSampleCount: options.minSampleCount,
    contestRepetitionCount: options.contestRepetitionCount ?? null,
    debug: options.debug,
    seed,
    timeout: options.timeout,
    nodeImport: options.nodeImport?.written ?? null,
    rawSamples: false,
  };
}

/** A random 32-bit seed for the repetition orders. */
function drawRandomSeed(): number {
  return randomInt(2 ** 32);
}

/**
 * Runs a benchmark run: resolves the options, selects the cases, then measures each selected case
 * on each runtime in its own child, one at a time, and each contest in repetitions of one child per
 * contender. It never prints.
 *
 * A failed case is a result with an `error`, never a throw, and does not stop the run. A plain
 * case's result is emitted when its child ends, a failed contender's when its failing child ends,
 * and the other contenders' when their contest's last repetition ends. When the stop signal fires,
 * the running child is killed, its case and the unfinished contenders of its contest get no
 * result, and no further child starts.
 *
 * @param input - The caller's options, the positional files, the stop signal, the result,
 *   selection, plan and dropped-children callbacks, the calls per sample to fix, and the functions
 *   that look a runtime up, start a child, list the CPUs, draw the seed and name the
 *   `package.json` to read the version from, the real ones by default.
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
  const host = hostOf(input.cpus ?? realCpus);
  const seed = (input.drawSeed ?? drawRandomSeed)();
  const results: Result[] = [];
  const contests: Contest[] = [];
  let contested = false;
  let debug = false;
  const { callsPerSample } = input;
  const reportOf = (options: ResolvedOptions, interrupted: boolean): Report => ({
    schema: 1,
    repset,
    startedAt,
    interrupted,
    options: reportOptions(input, options, contested ? seed : null),
    host,
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
      minSamples: resolved.minSampleCount,
      ...(callsPerSample === undefined ? {} : { callsPerSample }),
    }),
    {
      passed: (resolved, total, formed) => {
        contested = formed.length > 0;
        debug = resolved.debug;
        input.onSelected?.(reportOf(resolved, false), formed);
        input.onPlanned?.(total);
      },
      dropped: input.onDropped,
      ...resultHandlers(emit, record, () => debug),
    },
    seed,
  );
  return reportOf(options, interrupted);
}

/**
 * Runs every selected case once per runtime, each in its own child, with no timing, one at a time
 * in selection order; a contest's contenders run once each, forming no repetitions. A failed case
 * does not stop it.
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
