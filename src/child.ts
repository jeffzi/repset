/**
 * The child entry: a process the parent starts on Node or Bun to load one benchmark file and list
 * its cases, measure one case, or run one case once. It also defines `bench()` and the registry it
 * fills, which the package entry re-exports.
 *
 * The registry lives in one slot on `globalThis`, so every loaded copy of repset fills and reads
 * the same one: a benchmark file that registers through a copy the child never imports must not
 * look like a file with no benchmarks. The slot carries a format number, and a copy refuses a
 * format it does not know rather than misreading another version's registry.
 *
 * A measuring child loads this module beside the benchmark, so it imports only the `measure`
 * modules, `result-fd`, the generic helpers in `utils` and Node builtins: under Bun, module code a
 * child loads slows the timed calls even when it never runs.
 */
import { existsSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { GcDuringTiming } from "./measure/collections.js";
import {
  type Case,
  measure,
  MeasureError,
  type Measurement,
  type Phase,
  type Statistics,
  withCaseState,
} from "./measure/measure.js";
import { RESULT_FD } from "./result-fd.js";
import { describe, isRecord, thrownMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Benchmark registration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Request and result protocol
// ---------------------------------------------------------------------------

/** Lists the cases a benchmark file registers. */
export interface ListRequest {
  readonly mode: "list";
  readonly file: string;
}

/** Measures one case of a benchmark file. */
export interface MeasureRequest {
  readonly mode: "measure";
  readonly file: string;
  readonly id: string;
  readonly minTime: number;
  readonly minSamples: number;
  /** The calls per sample to measure at; absent means `measure` calibrates one. */
  readonly callsPerSample?: number;
}

/** Runs one case of a benchmark file once, with no timing. */
export interface OnceRequest {
  readonly mode: "once";
  readonly file: string;
  readonly id: string;
}

/** What the parent asks a child to do; `file` is an absolute path. */
export type ChildRequest = ListRequest | MeasureRequest | OnceRequest;

/** Where a child's work failed: a phase of `measure`, or `load` for the benchmark file. */
export type ChildPhase = Phase | "load";

/** A cleanup teardown's failure: its value's message, and its stack as {@link ChildError} encodes one. */
export interface TeardownFailure {
  readonly message: string;
  readonly stack: string | null;
}

export interface ChildError {
  readonly phase: ChildPhase;
  readonly message: string;
  /** The stack of the thrown `Error`, or `null` when the value was not one or had no string stack. */
  readonly stack: string | null;
  /** The failure of the teardown that cleaned up after this one, or `null` when none threw. */
  readonly teardownError: TeardownFailure | null;
}

export interface Failed {
  readonly status: "failed";
  readonly error: ChildError;
}

export interface ListedCase {
  readonly id: string;
  readonly setupPerCall: boolean;
}

export interface Listed {
  readonly status: "ok";
  readonly cases: ListedCase[];
}

/** How a measuring child's samples were taken, under the report's names. */
export type SamplingReport = Pick<
  Measurement,
  | "timerResolutionNs"
  | "callsPerSample"
  | "callsPerSampleFixed"
  | "warmupSamples"
  | "timingAttempts"
  | "timingMs"
>;

/** A measuring child's result: the report's per-process fields the child knows. */
export interface Measured {
  readonly status: "ok";
  readonly stats: Statistics;
  readonly sampling: SamplingReport;
  readonly checks: { readonly ratioToEmptyBody: number };
  /** The collections seen during timing, or `null` where the runtime delivers no `gc` entries. */
  readonly gc: GcDuringTiming | null;
}

/** A once child's result: the case ran, and nothing was timed. */
export interface Ran {
  readonly status: "ok";
}

export type ChildResult = Listed | Measured | Ran | Failed;

// ---------------------------------------------------------------------------
// Request parsing and result encoding
// ---------------------------------------------------------------------------

/**
 * Reads a string field of the request.
 *
 * @param request - The parsed request.
 * @param name - The field to read.
 * @returns The field's value.
 * @throws TypeError when the field is absent or not a string.
 */
function stringField(request: object, name: string): string {
  const value: unknown = Reflect.get(request, name);
  if (typeof value !== "string") {
    throw new TypeError(`the request's ${name} must be a string, got ${describe(value)}`);
  }
  return value;
}

/**
 * Reads a number field of the request.
 *
 * @param request - The parsed request.
 * @param name - The field to read.
 * @returns The field's value.
 * @throws TypeError when the field is absent or not a number.
 */
function numberField(request: object, name: string): number {
  const value: unknown = Reflect.get(request, name);
  if (typeof value !== "number") {
    throw new TypeError(`the request's ${name} must be a number, got ${describe(value)}`);
  }
  return value;
}

/**
 * Parses the child's request argument, before anything loads.
 *
 * @param argument - The request as JSON: `mode` and an absolute `file` always, `id` for `measure`
 *   and `once`, `minTime` and `minSamples` for `measure`, and optionally `callsPerSample` for
 *   `measure`.
 * @returns The request, holding only the fields its mode reads.
 * @throws SyntaxError when `argument` is not JSON.
 * @throws TypeError when the request is not an object, names an unknown mode, lacks a field its
 *   mode needs, holds a field of the wrong type, or names a relative file.
 */
export function parseRequest(argument: string): ChildRequest {
  const request: unknown = JSON.parse(argument);
  if (typeof request !== "object" || request === null) {
    throw new TypeError(`the request must be a JSON object, got ${describe(request)}`);
  }
  const mode: unknown = Reflect.get(request, "mode");
  const file = stringField(request, "file");
  if (!isAbsolute(file)) {
    throw new TypeError(`the request's file must be an absolute path, got ${describe(file)}`);
  }
  switch (mode) {
    case "list":
      return { mode, file };
    case "once":
      return { mode, file, id: stringField(request, "id") };
    case "measure": {
      const callsPerSample =
        Reflect.get(request, "callsPerSample") === undefined
          ? undefined
          : numberField(request, "callsPerSample");
      return {
        mode,
        file,
        id: stringField(request, "id"),
        minTime: numberField(request, "minTime"),
        minSamples: numberField(request, "minSamples"),
        ...(callsPerSample === undefined ? {} : { callsPerSample }),
      };
    }
    default:
      throw new TypeError(
        `the request's mode must be list, measure or once, got ${describe(mode)}`,
      );
  }
}

/** The message and stack of `thrown`, the stack taken from a `MeasureError`'s cause. */
function encodeThrown(thrown: unknown): TeardownFailure {
  const cause: unknown = thrown instanceof MeasureError ? thrown.cause : thrown;
  return {
    message: thrownMessage(thrown),
    stack: cause instanceof Error && typeof cause.stack === "string" ? cause.stack : null,
  };
}

/**
 * Encodes a failure as a result.
 *
 * @param phase - Where the work failed; a `MeasureError` carries its own phase instead.
 * @param thrown - The thrown value. For a `MeasureError`, the result takes its phase and message
 *   and the stack of its cause, since its own stack names only repset's frames, and its
 *   `teardownError` encoded the same way.
 * @returns The failed result: the message is an `Error`'s own or another value's string form, the
 *   stack `null` unless the cause is an `Error` with a string stack, and the teardown error `null`
 *   unless a cleanup teardown threw.
 */
function failedResult(phase: ChildPhase, thrown: unknown): Failed {
  const isMeasureError = thrown instanceof MeasureError;
  const teardownError = isMeasureError ? thrown.teardownError : null;
  return {
    status: "failed",
    error: {
      phase: isMeasureError ? thrown.phase : phase,
      ...encodeThrown(thrown),
      teardownError: teardownError === null ? null : encodeThrown(teardownError),
    },
  };
}

// ---------------------------------------------------------------------------
// Loading and running cases
// ---------------------------------------------------------------------------

/**
 * Lists the cases a benchmark file registers, in registration order.
 *
 * The file is imported by its file URL, so a Windows path loads too, and its top-level `await`
 * finishes before the registry is read. A file imported earlier in the same process does not
 * register again.
 *
 * @param file - The benchmark file's absolute path.
 * @returns Every registered case, a twice-registered id twice, or a failure in phase `load` when the
 *   import throws or rejects or the registry cannot be read.
 */
export async function listCases(file: string): Promise<Listed | Failed> {
  try {
    const cases = (await loadCases(file)).map(({ id, case: registered }) => ({
      id,
      setupPerCall: registered.kind === "perCall",
    }));
    return { status: "ok", cases };
  } catch (error) {
    return failedResult("load", error);
  }
}

/**
 * Measures the case `id` of a benchmark file; the file's other cases register but never run.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to measure.
 * @param sampling - The time in milliseconds and the sample count the body's timing must pass, and
 *   the calls per sample to measure at, calibrated when absent.
 * @returns The report's per-process fields, or a failure: in phase `load` when the file fails to
 *   load or `id` does not select exactly one case, otherwise in the phase `measure` failed in.
 */
export async function measureCase(
  file: string,
  id: string,
  sampling: Pick<MeasureRequest, "minTime" | "minSamples" | "callsPerSample">,
): Promise<Measured | Failed> {
  return withSelectedCase(file, id, async (selected) =>
    measuredResult(await measure(selected, sampling)),
  );
}

/**
 * Runs the case `id` of a benchmark file once: one `setup`, one `fn` call and one `teardown`, with
 * no timing and no collector, so it runs on a runtime that cannot measure.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to run.
 * @returns A success, or a failure: in phase `load` when the file fails to load or `id` does not
 *   select exactly one case, otherwise in the phase of the callback that failed.
 */
export async function runOnce(file: string, id: string): Promise<Ran | Failed> {
  return withSelectedCase(file, id, (selected): Ran => {
    withCaseState(selected, () => undefined);
    return { status: "ok" };
  });
}

/**
 * Imports a benchmark file by its file URL and reads what it registered.
 *
 * @param file - The benchmark file's absolute path.
 * @returns The registered cases, once the file's top-level `await` has finished.
 * @throws The value the import threw or rejected with, or the registry's TypeError.
 */
async function loadCases(file: string): Promise<readonly RegisteredCase[]> {
  await import(pathToFileURL(file).href);
  return registeredCases();
}

/**
 * Loads a benchmark file and picks the one case registered under `id`.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to pick.
 * @returns The case.
 * @throws Error naming `id` when no case or more than one is registered under it, and what
 *   {@link loadCases} throws.
 */
async function selectCase(file: string, id: string): Promise<Case<unknown>> {
  const matches = (await loadCases(file)).filter((registered) => registered.id === id);
  const [match] = matches;
  if (match === undefined) {
    throw new Error(`no benchmark is registered under the id ${id}`);
  }
  if (matches.length > 1) {
    throw new Error(`the id ${id} is registered ${matches.length} times`);
  }
  return match.case;
}

/**
 * Picks the case `id` of a benchmark file and runs `work` on it, encoding either failure as a result.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to pick.
 * @param work - Runs on the selected case; it may be asynchronous.
 * @returns What `work` returned, or a failure: in phase `load` when the file fails to load or `id`
 *   does not select exactly one case, otherwise in the phase `work` failed in.
 */
async function withSelectedCase<T>(
  file: string,
  id: string,
  work: (selected: Case<unknown>) => T | Promise<T>,
): Promise<T | Failed> {
  let selected: Case<unknown>;
  try {
    selected = await selectCase(file, id);
  } catch (error) {
    return failedResult("load", error);
  }
  try {
    return await work(selected);
  } catch (error) {
    // "child" is only the fallback for a value that is not a MeasureError: `work` throws
    // MeasureErrors alone, whose own phase the result carries.
    return failedResult("child", error);
  }
}

/** Splits `measure`'s flat measurement into the report's per-process fields. */
function measuredResult(measurement: Measurement): Measured {
  return {
    status: "ok",
    stats: {
      min: measurement.min,
      p25: measurement.p25,
      median: measurement.median,
      p75: measurement.p75,
      p99: measurement.p99,
      max: measurement.max,
      mean: measurement.mean,
      sampleCount: measurement.sampleCount,
    },
    sampling: {
      timerResolutionNs: measurement.timerResolutionNs,
      callsPerSample: measurement.callsPerSample,
      callsPerSampleFixed: measurement.callsPerSampleFixed,
      warmupSamples: measurement.warmupSamples,
      timingAttempts: measurement.timingAttempts,
      timingMs: measurement.timingMs,
    },
    checks: { ratioToEmptyBody: measurement.ratioToEmptyBody },
    gc: measurement.gcDuringTiming ?? null,
  };
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every mode, which tsc and switch-exhaustiveness-check enforce
async function respond(request: ChildRequest): Promise<ChildResult> {
  switch (request.mode) {
    case "list":
      return listCases(request.file);
    case "measure":
      return measureCase(request.file, request.id, request);
    case "once":
      return runOnce(request.file, request.id);
  }
}

/** Resolves once everything written to `stream` before the call has been handed off. */
async function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    // A write error (a parent that closed the pipe) must not turn a written result into a failed
    // exit, so it resolves too.
    stream.write("", () => {
      resolve();
    });
  });
}

/** Whether the process was started on this module, compared as real paths so links match. */
function startedOnThisModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !existsSync(entry)) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

/**
 * Answers the request on the command line, writes the result line, and exits.
 *
 * The explicit exit ends the child even when the file left a handle open; it waits for the output
 * streams first, which a piped stream on Node otherwise loses.
 *
 * @throws SyntaxError when the request argument is not JSON.
 * @throws TypeError when {@link parseRequest} rejects the request.
 * @throws Error when writing the result line on {@link RESULT_FD} fails.
 */
async function main(): Promise<void> {
  const result = await respond(parseRequest(process.argv[2] ?? ""));
  writeSync(RESULT_FD, `${JSON.stringify(result)}\n`);
  await flushed(process.stdout);
  await flushed(process.stderr);
  process.exit(0);
}

/** The `globalThis` slot the first copy of this module to answer the request sets. */
const ANSWERING_KEY = Symbol.for("repset.child.answering");

/**
 * Claims the request for this copy of the module. A loader such as tsx can evaluate this module
 * twice in one process, once as the entry and once through the benchmark file's `bench` import,
 * and only one copy may write the result line.
 *
 * @returns `true` for the first copy to ask, `false` for every later one.
 */
function claimAnswer(): boolean {
  if (Reflect.get(globalThis, ANSWERING_KEY) === true) return false;
  Reflect.set(globalThis, ANSWERING_KEY, true);
  return true;
}

// Not awaited at the top level: the benchmark file imports `bench` from this module, and a
// top-level await would leave this module evaluating while that import waits for it to finish.
if (startedOnThisModule() && claimAnswer()) void main();
