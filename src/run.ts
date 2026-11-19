/**
 * A run: one child per selected case and runtime, measuring the case or running it once, and a
 * contest's contenders in rounds of one child each.
 */
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus as realCpus } from "node:os";
import { fileURLToPath } from "node:url";

import type { ChildError, ChildRequest, MeasureRequest } from "./child.js";
import {
  type FoundRuntime,
  type Outcome,
  startChild as realStartChild,
  type StartOptions,
} from "./children.js";
import { quantile } from "./measure/measure.js";
import type { Runtime } from "./measure/runtime.js";
import { type OptionsInput, resolveOptions, type ResolvedOptions } from "./options.js";
import type {
  Machine,
  MeasuredProcess,
  Report,
  ReportOptions,
  Result,
  ResultBase,
} from "./report.js";
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
   * the benchmark files to list, then one child per case and runtime to measure or run once, and
   * one per contender in each round of a contest.
   */
  readonly onPlanned?: ((total: number) => void) | undefined;
}

export interface RunInput extends OnceInput {
  /** Receives each result when it finishes, before the next child starts. */
  readonly onResult?: ((result: Result) => void) | undefined;
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

/** How a child asked for `M` ended when the caller did not stop it. */
type Finished<M extends ChildRequest["mode"]> = Exclude<Outcome<M>, { status: "stopped" }>;

/** What the process of a failed child did not reach. */
const NOTHING_MEASURED = {
  stats: null,
  sampling: null,
  checks: null,
  gc: null,
  rawSamples: null,
} as const;

/** One child's outcome, with its case, its runtime, and when it ran within its group. */
interface Step<M extends ChildRequest["mode"]> {
  readonly runtime: FoundRuntime;
  readonly selected: SelectedCase;
  readonly outcome: Finished<M>;
  readonly round: number;
  readonly orderInRound: number;
}

/** What the children's outcomes are passed to while a run starts them. */
interface StartHandlers<M extends ChildRequest["mode"]> {
  /**
   * Called once the selection passed, before the first child of a case starts, with the number of
   * children the cases will start, rounds included, and whether a contest formed.
   */
  readonly passed: (options: ResolvedOptions, total: number, contested: boolean) => void;
  /** Receives each child's outcome before the next child starts. */
  readonly finished: (step: Step<M>) => void;
  /** Receives the number of planned children a failed case will no longer start, when there are some. */
  readonly dropped?: ((count: number) => void) | undefined;
  /** Called when the last round of a group ended on a runtime, before the next child starts. */
  readonly ended?: ((runtime: FoundRuntime, group: readonly SelectedCase[]) => void) | undefined;
}

/** What starting the children of one group takes, shared by every group of a run. */
interface GroupStart<R extends ChildRequest> {
  readonly options: ResolvedOptions;
  readonly request: (options: ResolvedOptions, selected: SelectedCase) => R;
  readonly handlers: StartHandlers<R["mode"]>;
  readonly startChild: NonNullable<OnceInput["startChild"]>;
  readonly childOptions: StartOptions;
  /** Draws the numbers that order each round of a contest. */
  readonly random: () => number;
}

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

/** A random 32-bit seed for the round orders. */
function drawRandomSeed(): number {
  return randomInt(2 ** 32);
}

/** Mulberry32: numbers uniform in [0, 1), the same sequence for the same 32-bit `seed`. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A uniformly random permutation of `items`, by Fisher–Yates over `random`. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const order = [...items];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [valueAt(order, other), valueAt(order, index)];
  }
  return order;
}

/**
 * Groups the selected cases into what runs in turn: each plain case alone, and the selected
 * contenders of one benchmark together, at the place of the first of them.
 *
 * @param cases - The selected cases, in selection order.
 * @returns The groups, in the order they run; a group of two or more contenders is a contest.
 */
function groupsOf(cases: readonly SelectedCase[]): SelectedCase[][] {
  const groups: SelectedCase[][] = [];
  const contests = new Map<string, SelectedCase[]>();
  for (const selected of cases) {
    if (selected.contender === null) {
      groups.push([selected]);
      continue;
    }
    const benchmark = JSON.stringify([selected.path, selected.name]);
    const contest = contests.get(benchmark);
    if (contest === undefined) {
      const group = [selected];
      contests.set(benchmark, group);
      groups.push(group);
    } else {
      contest.push(selected);
    }
  }
  return groups;
}

/**
 * Counts the rounds a group runs.
 *
 * @param size - The number of cases in the group.
 * @param rounds - The `rounds` option.
 * @returns 1 for a lone case; otherwise `rounds`, or when unset the smallest `n` with
 *   `4 / 2ⁿ ≤ 0.05 / pairs`, at which a pair can pass Holm's strictest step with one round
 *   dissenting.
 */
function roundsOf(size: number, rounds: number | undefined): number {
  if (size < 2) return 1;
  if (rounds !== undefined) return rounds;
  const pairs = (size * (size - 1)) / 2;
  let count = 1;
  while (4 / 2 ** count > 0.05 / pairs) count += 1;
  return count;
}

/** One round of a group: its cases in the order they start. */
interface Round {
  readonly order: readonly SelectedCase[];
  /** From 1. */
  readonly number: number;
  /** The rounds still to come after this one. */
  readonly remaining: number;
}

/**
 * Starts one child per case of a round, back to back, in its order.
 *
 * @param start - What starting a child takes.
 * @param runtime - The runtime the children run on.
 * @param round - The round to start.
 * @param signal - The caller's stop signal.
 * @returns The cases whose child failed, or `undefined` when the stop signal ended the round.
 * @throws {@link Error} What `finished` or `dropped` throws, or what starting a child throws.
 */
async function startRound<R extends ChildRequest>(
  start: GroupStart<R>,
  runtime: FoundRuntime,
  round: Round,
  signal: AbortSignal | undefined,
): Promise<SelectedCase[] | undefined> {
  const { options, request, handlers, startChild, childOptions } = start;
  const failed: SelectedCase[] = [];
  for (const [index, selected] of round.order.entries()) {
    if (signal?.aborted === true) return undefined;
    const outcome = await startChild(runtime, request(options, selected), childOptions);
    if (outcome.status === "stopped") return undefined;
    handlers.finished({ runtime, selected, outcome, round: round.number, orderInRound: index + 1 });
    if (outcome.status !== "failed") continue;
    failed.push(selected);
    if (round.remaining > 0) handlers.dropped?.(round.remaining);
  }
  return failed;
}

/**
 * Starts the children of one group on one runtime: each round in a fresh random order for a
 * contest, one child per case still running, back to back. A case whose child fails runs in no
 * later round.
 *
 * @param start - What starting a child takes.
 * @param runtime - The runtime the children run on.
 * @param group - The group's cases, in selection order.
 * @param signal - The caller's stop signal.
 * @returns Whether the stop signal ended the group: before a child, or by stopping the running one.
 * @throws {@link Error} What `finished` or `dropped` throws, or what starting a child throws.
 */
async function startGroup<R extends ChildRequest>(
  start: GroupStart<R>,
  runtime: FoundRuntime,
  group: readonly SelectedCase[],
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const rounds = roundsOf(group.length, start.options.rounds);
  let running = group;
  for (let number = 1; number <= rounds; number += 1) {
    const order = group.length > 1 ? shuffled(running, start.random) : running;
    const round = { order, number, remaining: rounds - number };
    const failed = await startRound(start, runtime, round, signal);
    if (failed === undefined) return true;
    running = running.filter((selected) => !failed.includes(selected));
  }
  return false;
}

/**
 * Resolves the caller's options, selects the cases, then starts their children one at a time,
 * runtime by runtime in the selection's order, cases in selection order. With a seed, the selected
 * contenders of one benchmark form a contest, which runs all its rounds at the place of its first
 * contender; without one, every case runs once.
 *
 * @param input - The caller's options, the positional files, the stop signal, the plan callback
 *   and the child functions.
 * @param request - The request of one case's child, from the resolved options.
 * @param handlers - What the selection and each child's outcome are passed to.
 * @param seed - The seed of the round orders, or `undefined` to form no contest.
 * @returns The resolved options, and whether the stop signal ended the run before every child ran:
 *   during listing, before the next child, or by stopping the running one.
 * @throws `ConfigError` When the options are invalid or the selection fails, before any child
 *   but the listing children starts.
 * @throws {@link Error} What the plan callback or a handler throws, or what starting a child
 *   throws.
 */
async function startEach<R extends ChildRequest>(
  input: OnceInput,
  request: (options: ResolvedOptions, selected: SelectedCase) => R,
  handlers: StartHandlers<R["mode"]>,
  seed?: number,
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
  const groups =
    seed === undefined ? selection.cases.map((selected) => [selected]) : groupsOf(selection.cases);
  const childrenPerRuntime = groups.reduce(
    (total, group) => total + group.length * roundsOf(group.length, options.rounds),
    0,
  );
  const contested = groups.some((group) => group.length > 1);
  handlers.passed(options, selection.runtimes.length * childrenPerRuntime, contested);
  const childOptions = startOptions(options, signal);
  const start = { options, request, handlers, startChild, childOptions, random: seeded(seed ?? 0) };
  for (const runtime of selection.runtimes) {
    for (const group of groups) {
      if (await startGroup(start, runtime, group, signal)) return { options, interrupted: true };
      handlers.ended?.(runtime, group);
    }
  }
  return { options, interrupted: false };
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

/**
 * The handlers that turn measuring children into results: a case gathers one process per round;
 * a failed child finishes its case at once, and the rest finish when their group's last round
 * ends. A group the stop signal ends gives no further result.
 *
 * @param emit - Receives each result as it finishes.
 * @returns The handlers of each child's outcome and of each group's end.
 */
function resultHandlers(
  emit: (result: Result) => void,
): Pick<StartHandlers<"measure">, "finished" | "ended"> {
  const ran = new Map<SelectedCase, MeasuredProcess[]>();
  return {
    finished: ({ runtime, selected, outcome, round, orderInRound }) => {
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
      const failed = { round, orderInRound, ...NOTHING_MEASURED };
      const base = resultBase(selected, runtime);
      emit({ ...base, status: "failed", error, median: null, processes: [...processes, failed] });
    },
    ended: (runtime, group) => {
      for (const selected of group) {
        const [first, ...rest] = ran.get(selected) ?? [];
        ran.delete(selected);
        if (first === undefined) continue;
        const processes: [MeasuredProcess, ...MeasuredProcess[]] = [first, ...rest];
        const medians = processes.map((process) => process.stats.median).toSorted((a, b) => a - b);
        const median = quantile(medians, 0.5);
        emit({ ...resultBase(selected, runtime), status: "ok", error: null, median, processes });
      }
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
    contests: [],
  });
  const emit = (result: Result): void => {
    results.push(result);
    input.onResult?.(result);
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
      ...resultHandlers(emit),
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
