/**
 * The child entry: a process the parent starts on Node or Bun to load one benchmark file and list
 * its cases, measure one case, or run one case once, reading the cases the file registered through
 * `bench()`.
 *
 * A measuring child loads this module beside the benchmark, so it imports only the `measure`
 * modules, `bench`, `result-fd`, the generic helpers in `utils` and Node builtins: under Bun, module
 * code a child loads slows the timed calls even when it never runs.
 */
import { existsSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type RegisteredCase, registeredCases } from "./bench.js";
import {
  type Case,
  measure,
  MeasureError,
  type Measurement,
  type Phase,
  withCaseState,
} from "./measure/measure.js";
import { RESULT_FD } from "./result-fd.js";
import { describe, errorStack, isInstance, thrownMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Request and result protocol
// ---------------------------------------------------------------------------

/** Lists the cases a benchmark file registers. */
interface ListRequest {
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

/**
 * A cleanup teardown's failure: its value's message, and its stack as {@link ChildError} encodes
 * one.
 */
interface TeardownFailure {
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

export interface ListedCase extends Pick<RegisteredCase, "id" | "name" | "contender"> {
  readonly setupPerCall: boolean;
}

export interface Listed {
  readonly status: "ok";
  readonly cases: ListedCase[];
}

/** A measuring child's result: the report's per-process fields the child knows. */
export interface Measured extends Measurement {
  readonly status: "ok";
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
      const fixedCount =
        Reflect.get(request, "callsPerSample") === undefined
          ? {}
          : { callsPerSample: numberField(request, "callsPerSample") };
      return {
        mode,
        file,
        id: stringField(request, "id"),
        minTime: numberField(request, "minTime"),
        minSamples: numberField(request, "minSamples"),
        ...fixedCount,
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
  const cause: unknown = isInstance(thrown, MeasureError) ? thrown.cause : thrown;
  return { message: thrownMessage(thrown), stack: errorStack(cause) };
}

/**
 * Encodes a failure as a result.
 *
 * @param phase - Where the work failed; a `MeasureError` carries its own phase instead.
 * @param thrown - The thrown value. For a `MeasureError`, the result takes its phase and message
 *   and the stack of its cause, since its own stack names only repset's frames, and its
 *   `teardownError` encoded the same way.
 * @returns The failed result: the message is the string form of an `Error`'s own message or of
 *   another value, or a placeholder for a value that has none; the stack `null` unless the cause
 *   is an `Error` whose stack reads as a string; and the teardown error `null` unless a cleanup
 *   teardown threw.
 */
function failedResult(phase: ChildPhase, thrown: unknown): Failed {
  const isMeasureError = isInstance(thrown, MeasureError);
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
    const cases = (await loadCases(file)).map(({ id, name, contender, case: registered }) => ({
      id,
      setupPerCall: registered.kind === "perCall",
      name,
      contender,
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
  return withSelectedCase(file, id, async (selected) => ({
    status: "ok",
    ...(await measure(selected, sampling)),
  }));
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
 * twice in one process, and only one copy may write the result line.
 *
 * @returns `true` for the first copy to ask, `false` for every later one.
 */
function claimAnswer(): boolean {
  if (Reflect.get(globalThis, ANSWERING_KEY) === true) return false;
  Reflect.set(globalThis, ANSWERING_KEY, true);
  return true;
}

// Not awaited at the top level: `main()` imports the benchmark file, so awaiting it here would keep
// this module evaluating until that file finishes loading.
if (startedOnThisModule() && claimAnswer()) void main();
