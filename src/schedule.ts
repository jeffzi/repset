/**
 * Starting a run's children: the selection, then one child per case and runtime, and a contest's
 * contenders in repetitions of one child each, in a seeded random order per repetition.
 */
import type { ChildError, ChildRequest } from "./child-protocol.js";
import type { FoundRuntime, Outcome, StartOptions } from "./children.js";
import { type OptionsInput, resolveOptions, type ResolvedOptions } from "./options.js";
import { type ChildFunctions, type SelectedCase, selectCases, startOptions } from "./select.js";
import { pairsOf, valueAt } from "./utils.js";

export interface OnceInput extends OptionsInput, ChildFunctions {
  /** Paths or globs of benchmark files, relative to `cwd`; when there are some, they replace `include`. */
  readonly files?: readonly string[] | undefined;
  /** Kills the running child and starts no further one when it fires. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Receives the number of children each phase will start, before that phase's first child starts:
   * the benchmark files to list, then one child per case and runtime to measure or run once, and
   * one per contender in each repetition of a contest.
   */
  readonly onPlanned?: ((total: number) => void) | undefined;
  /**
   * Receives a case's failure, before the next child starts, when the `debug` option is on: the
   * error its child gave, stack included, and the tail of the child's output.
   */
  readonly onDebugFailure?:
    | ((failure: { readonly error: ChildError; readonly output: string }) => void)
    | undefined;
}

/** How a child asked for `M` ended when the caller did not stop it. */
type Finished<M extends ChildRequest["mode"]> = Exclude<Outcome<M>, { status: "stopped" }>;

/**
 * One child's outcome, with its case, its group, its runtime, and when it ran within its group: its
 * repetition and its order in it, both from 1 in a contest and `null` for a plain case.
 */
interface Step<M extends ChildRequest["mode"]> {
  readonly runtime: FoundRuntime;
  readonly selected: SelectedCase;
  readonly group: readonly SelectedCase[];
  readonly outcome: Finished<M>;
  readonly repetition: number | null;
  readonly orderInRepetition: number | null;
}

/** What the children's outcomes are passed to while a run starts them. */
export interface StartHandlers<M extends ChildRequest["mode"]> {
  /**
   * Called once the selection passed, before the first child of a case starts, with the number of
   * children the cases will start, repetitions included, and the cases of each contest that
   * formed, the same on every runtime.
   */
  readonly passed: (
    options: ResolvedOptions,
    total: number,
    contests: readonly (readonly SelectedCase[])[],
  ) => void;
  /** Receives each child's outcome before the next child starts. */
  readonly finished: (step: Step<M>) => void;
  /** Receives the number of planned children a failed case will no longer start, when there are some. */
  readonly dropped?: ((count: number) => void) | undefined;
  /** Called when a group's last repetition ended on a runtime, before the next child starts. */
  readonly ended?: ((runtime: FoundRuntime, group: readonly SelectedCase[]) => void) | undefined;
}

/**
 * Builds the request of one case's child from the resolved options and the repetition the child
 * runs in: from 1 in a contest, `null` for a plain case.
 */
type RequestOf<R extends ChildRequest> = (
  options: ResolvedOptions,
  selected: SelectedCase,
  repetition: number | null,
) => R;

/** What starting the children of one group takes, shared by every group of a run. */
interface GroupStart<R extends ChildRequest> {
  readonly options: ResolvedOptions;
  readonly request: RequestOf<R>;
  readonly handlers: StartHandlers<R["mode"]>;
  readonly startChild: OnceInput["startChild"];
  readonly childOptions: StartOptions;
  /** Draws the numbers that order each repetition of a contest. */
  readonly random: () => number;
  readonly onDebugFailure: OnceInput["onDebugFailure"];
}

// ---------------------------------------------------------------------------
// Seeded ordering
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Contest planning
// ---------------------------------------------------------------------------

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
    const benchmark = contestKey(selected);
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
 * The key the contenders of one contest share: their benchmark's file and name. Planning groups the
 * selected contenders by it, and the table groups a stopped contest's results by it.
 *
 * @param contender - The case, selected or reported, whose `file` is the benchmark file as shown.
 * @returns The same string for every contender of one benchmark, a different one for any other.
 */
export function contestKey({
  file,
  name,
}: {
  readonly file: string;
  readonly name: string;
}): string {
  return JSON.stringify([file, name]);
}

/** The significance level of a contest's family of pairs. */
export const ALPHA = 0.05;

/** Whether `group` holds two or more cases, which makes it a contest. */
export function isContest(group: readonly SelectedCase[]): boolean {
  return group.length > 1;
}

/**
 * Counts the repetitions a group runs.
 *
 * @param size - The number of cases in the group.
 * @param options - The resolved options, whose `measure` and `contestRepetitionCount` it reads.
 * @returns 1 for a lone case, and for a contest when `measure` holds no `time`, since repetitions
 *   only order timings and memory is read once; otherwise `contestRepetitionCount`, or when unset
 *   the smallest `n` with `4 / 2ⁿ ≤ ALPHA / pairs`, at which a pair can pass Holm's strictest step
 *   with one repetition dissenting.
 */
function repetitionsOf(
  size: number,
  options: Pick<ResolvedOptions, "measure" | "contestRepetitionCount">,
): number {
  const { contestRepetitionCount } = options;
  if (size < 2 || !options.measure.includes("time")) return 1;
  if (contestRepetitionCount !== undefined) return contestRepetitionCount;
  const pairs = pairsOf(size);
  for (let count = 1; ; count += 1) {
    const pAtOneDissent = 4 / 2 ** count;
    if (pAtOneDissent <= ALPHA / pairs) return count;
  }
}

// ---------------------------------------------------------------------------
// Starting children
// ---------------------------------------------------------------------------

/** One repetition of a group: its cases in the order they start. */
interface Repetition {
  /** Every case of the group, in selection order, failed ones included. */
  readonly group: readonly SelectedCase[];
  readonly order: readonly SelectedCase[];
  /** From 1. */
  readonly number: number;
  /** The repetitions still to come after this one. */
  readonly remaining: number;
}

/**
 * Starts one child per case of a repetition, back to back, in its order.
 *
 * @param start - What starting a child takes.
 * @param runtime - The runtime the children run on.
 * @param repetition - The repetition to start.
 * @returns The cases whose child failed, or `undefined` when the stop signal ended the repetition.
 * @throws {@link Error} What `finished`, `dropped` or `onDebugFailure` throws, or what starting a
 *   child throws.
 */
async function startRepetition<R extends ChildRequest>(
  start: GroupStart<R>,
  runtime: FoundRuntime,
  repetition: Repetition,
): Promise<SelectedCase[] | undefined> {
  const { options, request, handlers, startChild, childOptions, onDebugFailure } = start;
  const { group, number, remaining } = repetition;
  const contest = isContest(group);
  const inRepetition = contest ? number : null;
  const failed: SelectedCase[] = [];
  for (const [index, selected] of repetition.order.entries()) {
    if (childOptions.signal?.aborted === true) return undefined;
    const asked = request(options, selected, inRepetition);
    const outcome = await startChild(runtime, asked, childOptions);
    if (outcome.status === "stopped") return undefined;
    handlers.finished({
      runtime,
      selected,
      group,
      outcome,
      repetition: inRepetition,
      orderInRepetition: contest ? index + 1 : null,
    });
    if (outcome.status !== "failed") continue;
    if (options.debug) onDebugFailure?.(outcome);
    failed.push(selected);
    if (remaining > 0) handlers.dropped?.(remaining);
  }
  return failed;
}

/**
 * Starts the children of one group on one runtime: each repetition in a fresh random order for a
 * contest, one child per case still running, back to back. A case whose child fails runs in no
 * later repetition.
 *
 * @param start - What starting a child takes.
 * @param runtime - The runtime the children run on.
 * @param group - The group's cases, in selection order.
 * @returns Whether the stop signal ended the group: before a child, or by stopping the running one.
 * @throws {@link Error} What `finished`, `dropped` or `onDebugFailure` throws, or what starting a
 *   child throws.
 */
async function startGroup<R extends ChildRequest>(
  start: GroupStart<R>,
  runtime: FoundRuntime,
  group: readonly SelectedCase[],
): Promise<boolean> {
  const count = repetitionsOf(group.length, start.options);
  let running = group;
  for (let number = 1; number <= count; number += 1) {
    const order = isContest(group) ? shuffled(running, start.random) : running;
    const repetition = { group, order, number, remaining: count - number };
    const failed = await startRepetition(start, runtime, repetition);
    if (failed === undefined) return true;
    running = running.filter((selected) => !failed.includes(selected));
  }
  return false;
}

/**
 * Resolves the caller's options, selects the cases, then starts their children one at a time,
 * runtime by runtime in the selection's order, cases in selection order. With a seed, the selected
 * contenders of one benchmark form a contest, which runs all its repetitions at the place of its
 * first contender; without one, every case runs once.
 *
 * @param input - The caller's options, the positional files, the stop signal, the plan callback
 *   and the child functions.
 * @param request - The request of one case's child, from the resolved options and its repetition.
 * @param handlers - What the selection and each child's outcome are passed to.
 * @param seed - The seed of the repetition orders, or `undefined` to form no contest.
 * @returns The resolved options, and whether the stop signal ended the run before every child ran:
 *   during listing, before the next child, or by stopping the running one.
 * @throws `ConfigError` When the options are invalid or the selection fails, before any child
 *   but the listing children starts.
 * @throws {@link Error} What the plan callback or a handler throws, or what starting a child
 *   throws.
 */
export async function startEach<R extends ChildRequest>(
  input: OnceInput,
  request: RequestOf<R>,
  handlers: StartHandlers<R["mode"]>,
  seed?: number,
): Promise<{ options: ResolvedOptions; interrupted: boolean }> {
  const options = await resolveOptions(input);
  const { signal, startChild } = input;
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
    (total, group) => total + group.length * repetitionsOf(group.length, options),
    0,
  );
  const contests = groups.filter(isContest);
  handlers.passed(options, selection.runtimes.length * childrenPerRuntime, contests);
  const childOptions = startOptions(options, signal);
  const start = {
    options,
    request,
    handlers,
    startChild,
    childOptions,
    random: seeded(seed ?? 0),
    onDebugFailure: input.onDebugFailure,
  };
  for (const runtime of selection.runtimes) {
    for (const group of groups) {
      if (await startGroup(start, runtime, group)) return { options, interrupted: true };
      handlers.ended?.(runtime, group);
    }
  }
  return { options, interrupted: false };
}
