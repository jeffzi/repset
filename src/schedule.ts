/**
 * Starting a run's children: the selection, then one child per case and runtime, and a contest's
 * contenders in rounds of one child each, in a seeded random order per round.
 */
import { randomInt } from "node:crypto";

import type { ChildRequest } from "./child.js";
import {
  type FoundRuntime,
  type Outcome,
  startChild as realStartChild,
  type StartOptions,
} from "./children.js";
import { type OptionsInput, resolveOptions, type ResolvedOptions } from "./options.js";
import {
  type ChildFunctionOverrides,
  type SelectedCase,
  selectCases,
  startOptions,
} from "./select.js";
import { valueAt } from "./utils.js";

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

/** How a child asked for `M` ended when the caller did not stop it. */
type Finished<M extends ChildRequest["mode"]> = Exclude<Outcome<M>, { status: "stopped" }>;

/** One child's outcome, with its case, its group, its runtime, and when it ran within its group. */
interface Step<M extends ChildRequest["mode"]> {
  readonly runtime: FoundRuntime;
  readonly selected: SelectedCase;
  readonly group: readonly SelectedCase[];
  readonly outcome: Finished<M>;
  readonly round: number;
  readonly orderInRound: number;
}

/** What the children's outcomes are passed to while a run starts them. */
export interface StartHandlers<M extends ChildRequest["mode"]> {
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

/** A random 32-bit seed for the round orders. */
export function drawRandomSeed(): number {
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
  /** Every case of the group, in selection order, failed ones included. */
  readonly group: readonly SelectedCase[];
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
    const { group, number } = round;
    handlers.finished({
      runtime,
      selected,
      group,
      outcome,
      round: number,
      orderInRound: index + 1,
    });
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
    const round = { group, order, number, remaining: rounds - number };
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
export async function startEach<R extends ChildRequest>(
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
