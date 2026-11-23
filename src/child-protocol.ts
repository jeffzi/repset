/**
 * The protocol between the parent and a child: the request the parent passes a child as its
 * argument, and the one result line the child writes back, with the child's parsing of the one and
 * encoding of the other.
 *
 * A measuring child loads this module, so it holds nothing only the parent runs and imports only
 * the `measure` modules, the generic helpers in `utils`, Node builtins and the types of `bench`;
 * parent modules import its types alone.
 */
import { isAbsolute } from "node:path";

import type { RegisteredCase } from "./bench.js";
import { type Measurement, MeasureError, type Phase, type Statistics } from "./measure/measure.js";
import { describe, errorStack, isInstance, thrownMessage } from "./utils.js";

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
  readonly callsPerSample?: number | undefined;
  /** Whether to time the case. */
  readonly time: boolean;
  /** Whether to read the case's heap bytes per call, after timing when `time` is set too. */
  readonly memory: boolean;
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

/** A thrown value's message and stack. */
interface EncodedThrown {
  readonly message: string;
  /** The stack of the thrown `Error`, or `null` when the value was not one or had no string stack. */
  readonly stack: string | null;
}

export interface ChildError extends EncodedThrown {
  readonly phase: ChildPhase;
  /** The failure of the teardown that cleaned up after this one, or `null` when none threw. */
  readonly teardownError: EncodedThrown | null;
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

/** A measurement's `time` block: the report's timing fields the child knows. */
export interface MeasuredTime extends Measurement {
  readonly rawSamples: null;
}

/** A measurement's `memory` block: the memory pass's reading, in bytes per call. */
export interface MeasuredMemory {
  /** The per-call statistics of the kept paired differences, or `null` when no pair was clean. */
  readonly stats: Statistics | null;
  readonly sampling: { readonly callsPerSample: number };
  readonly rawSamples: null;
}

/**
 * A measuring child's result: the `time` and `memory` blocks of the report's measurement entry,
 * each `null` when not asked, and `memory` `null` too on a runtime with no heap reading.
 */
export interface Measured {
  readonly status: "ok";
  readonly time: MeasuredTime | null;
  readonly memory: MeasuredMemory | null;
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
 * Reads a boolean field of the request.
 *
 * @param request - The parsed request.
 * @param name - The field to read.
 * @returns The field's value.
 * @throws TypeError when the field is absent or not a boolean.
 */
function booleanField(request: object, name: string): boolean {
  const value: unknown = Reflect.get(request, name);
  if (typeof value !== "boolean") {
    throw new TypeError(`the request's ${name} must be a boolean, got ${describe(value)}`);
  }
  return value;
}

/**
 * Parses the child's request argument, before anything loads.
 *
 * @param argument - The request as JSON: `mode` and an absolute `file` always, `id` for `measure`
 *   and `once`, `minTime`, `minSamples`, `time` and `memory` for `measure`, and optionally
 *   `callsPerSample` for `measure`.
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
    case "measure":
      return {
        mode,
        file,
        id: stringField(request, "id"),
        minTime: numberField(request, "minTime"),
        minSamples: numberField(request, "minSamples"),
        callsPerSample:
          Reflect.get(request, "callsPerSample") === undefined
            ? undefined
            : numberField(request, "callsPerSample"),
        time: booleanField(request, "time"),
        memory: booleanField(request, "memory"),
      };
    default:
      throw new TypeError(
        `the request's mode must be list, measure or once, got ${describe(mode)}`,
      );
  }
}

/** The message and stack of `thrown`, the stack taken from a `MeasureError`'s cause. */
function encodeThrown(thrown: unknown): EncodedThrown {
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
export function failedResult(phase: ChildPhase, thrown: unknown): Failed {
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
