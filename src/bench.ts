/**
 * `bench()` and the registry it fills, which the package entry re-exports and the child reads.
 *
 * The registry lives in one slot on `globalThis`, so every loaded copy of repset fills and reads
 * the same one: a benchmark file that registers through a copy the child never imports must not
 * look like a file with no benchmarks. The slot carries a format number, and a copy refuses a
 * format it does not know rather than misreading another version's registry.
 *
 * A measuring child loads this module beside the benchmark, so it imports only the `measure`
 * modules, the generic helpers in `utils` and nothing else: under Bun, module code a child loads
 * slows the timed calls even when it never runs.
 */
import type { Case } from "./measure/measure.js";
import { describe, isRecord } from "./utils.js";

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

/**
 * Bump when the registry's shape changes: a copy refuses any other number rather than misreading
 * it.
 */
const FORMAT = 1;

/** Shared by every call and every benchmark, so the default `setup` allocates nothing. */
const EMPTY_PARAMS: NoParams = Object.freeze({});

function noParams(): NoParams {
  return EMPTY_PARAMS;
}

/**
 * A function a case can hold in any of its slots. The optional parameter lets one type stand for
 * `setup`, which takes nothing, and for `fn` and `teardown`, which take the state.
 */
type CaseFunction = (state?: unknown) => unknown;

/** A benchmark object's fields, in the order an error message lists them. */
const FIELDS = ["setup", "fn", "teardown", "setupPerCall"] as const;

const KNOWN_FIELDS: ReadonlySet<string> = new Set(FIELDS);

/** One or more `/`-separated segments, each of ASCII letters, digits, `_`, `-` and `.`. */
const NAME_RULE = /^[\w.-]+(?:\/[\w.-]+)*$/u;

/** The `Symbol.toStringTag` of an `async function` and of an `async function*`. */
const ASYNC_TAGS: ReadonlyMap<unknown, string> = new Map([
  ["AsyncFunction", "an async function"],
  ["AsyncGeneratorFunction", "an async generator function"],
]);

function isCaseFunction(value: unknown): value is CaseFunction {
  return typeof value === "function";
}

/**
 * Checks that `name` is a string that keeps the name rule.
 *
 * @param name - The name passed to `bench()`.
 * @throws TypeError when `name` is not a string, has an empty segment, or holds a character the
 *   rule does not allow.
 */
function checkName(name: unknown): asserts name is string {
  if (typeof name !== "string") {
    throw new TypeError(`bench() takes a benchmark name that is a string, got ${describe(name)}`);
  }
  if (!NAME_RULE.test(name)) {
    throw new TypeError(
      `benchmark name ${JSON.stringify(name)} is not valid: a name is one or more "/"-separated segments, each made of ASCII letters, digits, "_", "-" and "."`,
    );
  }
}

/**
 * Checks that `value` is a function and not an `async function` or `async function*`, reading its
 * tag without calling it. A plain function that returns a promise passes: `measure` fails it when
 * its first call returns a thenable.
 *
 * @param subject - What `value` is, as an error message names it.
 * @param value - The function to check.
 * @returns `value` itself, narrowed to `CaseFunction`.
 * @throws TypeError when `value` is not a function, or is an `async function` or an
 *   `async function*`.
 */
function checkedFunction(subject: string, value: unknown): CaseFunction {
  if (!isCaseFunction(value)) {
    throw new TypeError(`${subject} must be a function, got ${describe(value)}`);
  }
  const asyncKind = ASYNC_TAGS.get(Reflect.get(value, Symbol.toStringTag));
  if (asyncKind !== undefined) {
    throw new TypeError(`${subject} is ${asyncKind}, but repset times synchronous code only`);
  }
  return value;
}

/**
 * Checks a benchmark object field that may be absent: `undefined` counts as absent.
 *
 * @param subject - The benchmark, as an error message names it.
 * @param benchmark - The benchmark object.
 * @param field - The field to read.
 * @returns The field's function, or `undefined` when the field is absent.
 * @throws TypeError when the field is neither `undefined` nor a function that is not an
 *   `async function` or `async function*`.
 */
function optionalFunction(
  subject: string,
  benchmark: object,
  field: "setup" | "teardown",
): CaseFunction | undefined {
  const value: unknown = Reflect.get(benchmark, field);
  return value === undefined ? undefined : checkedFunction(`${subject} field ${field}`, value);
}

/**
 * Builds the case a benchmark registers, after checking every field.
 *
 * @param name - The benchmark's name, already checked.
 * @param benchmark - The second argument passed to `bench()`.
 * @returns The case, holding the user's own functions.
 * @throws TypeError when `benchmark` is neither a function nor a benchmark object, or when the
 *   benchmark object has a field repset does not know or a field of the wrong type.
 */
function caseOf(name: string, benchmark: unknown): Case<unknown> {
  const subject = `benchmark ${JSON.stringify(name)}`;
  if (typeof benchmark === "function") {
    return { kind: "sharedState", setup: noParams, fn: checkedFunction(subject, benchmark) };
  }
  if (!isRecord(benchmark)) {
    throw new TypeError(
      `${subject} must be a function or a benchmark object, got ${describe(benchmark)}`,
    );
  }
  for (const field of Object.keys(benchmark)) {
    if (!KNOWN_FIELDS.has(field)) {
      throw new TypeError(
        `${subject} has the field ${JSON.stringify(field)}, which repset does not know: a benchmark's fields are ${FIELDS.join(", ")}`,
      );
    }
  }
  const fn = checkedFunction(`${subject} field fn`, Reflect.get(benchmark, "fn"));
  const setup = optionalFunction(subject, benchmark, "setup") ?? noParams;
  const teardown = optionalFunction(subject, benchmark, "teardown");
  const setupPerCall: unknown = Reflect.get(benchmark, "setupPerCall");
  if (setupPerCall !== undefined && typeof setupPerCall !== "boolean") {
    throw new TypeError(
      `${subject} field setupPerCall must be a boolean, got ${describe(setupPerCall)}`,
    );
  }
  return {
    kind: setupPerCall === true ? "perCall" : "sharedState",
    setup,
    fn,
    ...(teardown === undefined ? {} : { teardown }),
  };
}

/**
 * Checks that `slot` is a registry in this copy's format; the format number vouches for the rest of
 * its shape.
 *
 * @param slot - The object found in the registry slot on `globalThis`.
 * @returns Whether its format is this copy's, which narrows it to `Registry`.
 */
function isKnownRegistry(slot: object): slot is Registry {
  return Reflect.get(slot, "format") === FORMAT;
}

/**
 * Reads the registry slot on `globalThis`, creating it when it is empty.
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
 * Registration rejects an `async function` by its tag only. A plain function that returns a promise
 * registers, and `measure` fails the case when that function's first call returns a thenable.
 *
 * A rejected call registers nothing. A duplicate name is not rejected: both cases are kept.
 *
 * @param name - The benchmark's name, which becomes its case id.
 * @param benchmark - The function to time, or a benchmark object.
 * @throws TypeError when `name` breaks the name rule, when `benchmark` is not a function or a
 *   benchmark object, when a benchmark object has a field repset does not know or a field of the
 *   wrong type, or when `fn`, `setup` or `teardown` is an `async function` or `async function*`.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function bench<State = NoParams>(
  name: string,
  benchmark: ((params: NoParams) => unknown) | Benchmark<State>,
): void {
  checkName(name);
  // `caseOf` takes `unknown`: a case's state only ever flows from its own setup to its own fn and
  // teardown, so the registry erases State, and the checks cannot trust the compile-time type.
  const benchmarkCase = caseOf(name, benchmark);
  registry().push({ id: name, case: benchmarkCase });
}

/**
 * Reads every registered case.
 *
 * @returns The id and the `Case` of each registered benchmark, in registration order.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function registeredCases(): readonly RegisteredCase[] {
  return registry();
}
