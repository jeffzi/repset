/**
 * `bench()` and the registry it fills.
 *
 * The registry lives in one slot on `globalThis`, so every loaded copy of repset fills and reads
 * the same one: a benchmark file that registers through a copy the child never imports must not
 * look like a file with no benchmarks. The slot carries a format number, and a copy refuses a
 * format it does not know rather than misreading another version's registry.
 *
 * Every measuring child loads this module, so it imports no `node:` module and nothing at run time.
 */

import type { Case } from "./measure/measure.js";

/** The parameter combination `fn` receives when there is no `setup`; it has no key yet. */
type NoParams = Readonly<Record<string, never>>;

/** The object form of a benchmark: how to build its state, the body to time, how to release it. */
export interface Benchmark<State> {
  /** Builds the state off the clock; absent, `fn` receives the empty parameter combination. */
  readonly setup?: (() => State) | undefined;
  readonly fn: (state: NoInfer<State>) => unknown;
  /** Releases a state off the clock; absent means nothing to release. */
  readonly teardown?: ((state: NoInfer<State>) => void) | undefined;
  /** Runs `setup` before every call of `fn` and `teardown` after it. */
  readonly setupPerCall?: boolean | undefined;
}

/** A registered benchmark: its id and the case `measure` runs. */
export interface RegisteredCase {
  readonly id: string;
  readonly case: Case<unknown>;
}

interface Registry {
  readonly format: typeof FORMAT;
  readonly cases: RegisteredCase[];
}

const REGISTRY_KEY = Symbol.for("repset.registry");

/** The registry format this copy reads and writes. */
const FORMAT = 1;

/** Shared by every call and every benchmark, so the default `setup` allocates nothing. */
const EMPTY_PARAMS: NoParams = Object.freeze({});

function noParams(): NoParams {
  return EMPTY_PARAMS;
}

/**
 * Whether `slot` is a registry in this copy's format; the format number vouches for the rest of
 * its shape.
 */
function isKnownRegistry(slot: object): slot is Registry {
  return Reflect.get(slot, "format") === FORMAT;
}

/**
 * Returns the registered cases, creating the registry slot on `globalThis` when it is empty.
 *
 * @returns The live list of registered cases.
 * @throws TypeError when the slot holds a registry format this copy does not know, leaving the slot
 *   as it was.
 */
function registry(): RegisteredCase[] {
  const slot: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (slot === undefined) {
    const created: Registry = { format: FORMAT, cases: [] };
    Reflect.set(globalThis, REGISTRY_KEY, created);
    return created.cases;
  }
  const isObject = typeof slot === "object" && slot !== null;
  if (isObject && isKnownRegistry(slot)) {
    return slot.cases;
  }
  const found: unknown = isObject ? Reflect.get(slot, "format") : slot;
  throw new TypeError(
    `repset's registry on globalThis has format ${String(found)}, but this copy of repset reads format ${FORMAT}: load one version of repset`,
  );
}

/**
 * Registers a benchmark under `name`.
 *
 * `fn`, `setup` and `teardown` reach `measure` as the very functions given, so nothing sits
 * between the sampling loop and the body.
 *
 * @param name - The benchmark's name, which becomes its case id.
 * @param benchmark - The function to time, or a benchmark object.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function bench<State = NoParams>(
  name: string,
  benchmark: ((params: NoParams) => unknown) | Benchmark<State>,
): void {
  // TypeScript has no existential type for "a Case of some State". A case's state only ever flows
  // from its own setup to its own fn and teardown, so the registry erases State to `unknown`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the comment above
  const erased = benchmark as ((state: unknown) => unknown) | Benchmark<unknown>;
  const cases = registry();
  if (typeof erased === "function") {
    cases.push({ id: name, case: { kind: "sharedState", setup: noParams, fn: erased } });
    return;
  }
  const { setup = noParams, fn, teardown, setupPerCall } = erased;
  cases.push({
    id: name,
    case: {
      kind: setupPerCall === true ? "perCall" : "sharedState",
      setup,
      fn,
      ...(teardown === undefined ? {} : { teardown }),
    },
  });
}

/**
 * Returns every registered case, in registration order.
 *
 * @returns The id and the `Case` of each registered benchmark.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function registeredCases(): readonly RegisteredCase[] {
  return registry();
}
