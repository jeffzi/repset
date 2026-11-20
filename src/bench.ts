/**
 * `bench()`, which the package entry re-exports, and the registry it fills, which the child reads
 * through `registeredCases()`.
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

/** A body to time, which receives the state `setup` builds. */
type BenchFunction<State> = (state: NoInfer<State>) => unknown;

/** The object form of a benchmark: how to build its state, the body to time, how to release it. */
export interface Benchmark<State> {
  /** Builds the state off the clock; absent, `fn` receives the empty parameter combination. */
  readonly setup?: (() => State) | undefined;
  /**
   * The body to time, or a record of two or more contenders: each key registers its own case,
   * timing its own function with the benchmark's `setup`, `teardown` and `setupPerCall`.
   */
  readonly fn: BenchFunction<State> | Readonly<Record<string, BenchFunction<State>>>;
  /** Releases a state off the clock; absent means nothing to release. */
  readonly teardown?: ((state: NoInfer<State>) => void) | undefined;
  /** Runs `setup` before every call of `fn` and `teardown` after it. */
  readonly setupPerCall?: boolean | undefined;
}

/** A registered benchmark: its id, where it comes from, and the case `measure` runs. */
export interface RegisteredCase {
  /** The benchmark's name, followed by `/` and the contender key for a contender. */
  readonly id: string;
  /** The name passed to `bench()`. */
  readonly name: string;
  /** The contender's key in the record `fn`, or `null` for a benchmark with one `fn`. */
  readonly contender: string | null;
  readonly case: Case<unknown>;
}

/** A case `bench()` builds, before it gets its id. */
type ContenderCase = Pick<RegisteredCase, "contender" | "case">;

interface Registry {
  readonly format: typeof FORMAT;
  readonly cases: RegisteredCase[];
}

const REGISTRY_KEY = Symbol.for("repset.registry");

/**
 * Bump when the registry's shape changes: a copy refuses any other number rather than misreading
 * it.
 */
const FORMAT = 2;

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

/** One segment of a name: ASCII letters, digits, `_`, `-` and `.`. */
const SEGMENT = String.raw`[\w.-]+`;

/** The characters `SEGMENT` allows, as an error message words them. */
const SEGMENT_CHARS = 'ASCII letters, digits, "_", "-" and "."';

/** One or more `/`-separated segments. */
const NAME_RULE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, "u");

/** A contender key is one segment, so a contender's id adds exactly one segment to the name. */
const CONTENDER_RULE = new RegExp(`^${SEGMENT}$`, "u");

/** A contest compares functions, so it takes at least two. */
const MIN_CONTENDERS = 2;

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
      `benchmark name ${JSON.stringify(name)} is not valid: a name is one or more "/"-separated segments, each made of ${SEGMENT_CHARS}`,
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
 * Checks a benchmark object's `fn`, which is one function or a record of contenders.
 *
 * @param subject - The benchmark, as an error message names it.
 * @param fn - The `fn` field's value.
 * @returns Each function to time with its contender key, in the record's key order; a single
 *   function comes with the key `null`.
 * @throws TypeError when `fn` is not a function or a record, when a record has fewer than two
 *   contenders or a key that is not one segment of the name rule, or when a function is an
 *   `async function` or `async function*`.
 */
function contendersOf(
  subject: string,
  fn: unknown,
): { readonly contender: string | null; readonly fn: CaseFunction }[] {
  if (!isRecord(fn)) {
    return [{ contender: null, fn: checkedFunction(`${subject} field fn`, fn) }];
  }
  const keys = Object.keys(fn);
  if (keys.length < MIN_CONTENDERS) {
    throw new TypeError(
      `${subject} field fn must hold at least ${MIN_CONTENDERS} contenders, got ${keys.length}`,
    );
  }
  return keys.map((key) => {
    const contenderSubject = `${subject} contender ${JSON.stringify(key)}`;
    if (!CONTENDER_RULE.test(key)) {
      throw new TypeError(
        `${contenderSubject} is not valid: a contender key is one segment made of ${SEGMENT_CHARS}`,
      );
    }
    return { contender: key, fn: checkedFunction(contenderSubject, fn[key]) };
  });
}

/**
 * Builds the cases a benchmark registers, after checking every field.
 *
 * @param name - The benchmark's name, already checked.
 * @param benchmark - The second argument passed to `bench()`.
 * @returns One case per contender, or one case with the contender `null`, holding the user's own
 *   functions.
 * @throws TypeError when `benchmark` is neither a function nor a benchmark object, or when the
 *   benchmark object has a field repset does not know or a field of the wrong type.
 */
function casesOf(name: string, benchmark: unknown): ContenderCase[] {
  const subject = `benchmark ${JSON.stringify(name)}`;
  if (typeof benchmark === "function") {
    return [
      {
        contender: null,
        case: { kind: "sharedState", setup: noParams, fn: checkedFunction(subject, benchmark) },
      },
    ];
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
  const contenders = contendersOf(subject, Reflect.get(benchmark, "fn"));
  const setup = optionalFunction(subject, benchmark, "setup") ?? noParams;
  const teardown = optionalFunction(subject, benchmark, "teardown");
  const setupPerCall: unknown = Reflect.get(benchmark, "setupPerCall");
  if (setupPerCall !== undefined && typeof setupPerCall !== "boolean") {
    throw new TypeError(
      `${subject} field setupPerCall must be a boolean, got ${describe(setupPerCall)}`,
    );
  }
  const kind = setupPerCall === true ? "perCall" : "sharedState";
  return contenders.map(({ contender, fn }) => ({
    contender,
    case: { kind, setup, fn, ...(teardown === undefined ? {} : { teardown }) },
  }));
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
 * Registers a benchmark under `name`: one case, or one case per contender when `fn` is a record.
 *
 * `fn`, `setup` and `teardown` reach `measure` as the very functions given, so nothing sits
 * between the sampling loop and the body.
 *
 * Registration rejects an `async function` by its tag only. A plain function that returns a promise
 * registers, and `measure` fails the case when that function's first call returns a thenable.
 *
 * A rejected call registers nothing. A duplicate name is not rejected: both cases are kept.
 *
 * @param name - The benchmark's name, which becomes its case id; a contender's id is the name
 *   followed by `/` and the contender key.
 * @param benchmark - The function to time, or a benchmark object.
 * @throws TypeError when `name` breaks the name rule, when `benchmark` is not a function or a
 *   benchmark object, when a benchmark object has a field repset does not know or a field of the
 *   wrong type, when a record `fn` has fewer than two contenders or a key that is not one segment
 *   of the name rule, or when `fn`, a contender, `setup` or `teardown` is an `async function` or
 *   `async function*`.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function bench<State = NoParams>(
  name: string,
  benchmark: ((params: NoParams) => unknown) | Benchmark<State>,
): void {
  checkName(name);
  // `casesOf` takes `unknown`: a case's state only ever flows from its own setup to its own fn and
  // teardown, so the registry erases State, and the checks cannot trust the compile-time type.
  const cases = casesOf(name, benchmark);
  const registered = registry();
  for (const { contender, case: benchmarkCase } of cases) {
    const id = contender === null ? name : `${name}/${contender}`;
    registered.push({ id, name, contender, case: benchmarkCase });
  }
}

/**
 * Reads every registered case.
 *
 * @returns The id, name, contender and `Case` of each registered case, in registration order.
 * @throws TypeError when the registry on `globalThis` has a format this copy does not know.
 */
export function registeredCases(): readonly RegisteredCase[] {
  return registry();
}
