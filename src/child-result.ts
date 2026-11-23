/**
 * Reading a child's result: the one line it writes on file descriptor {@link RESULT_FD}, checked
 * against the shape its request's mode asks for.
 */
import type {
  ChildPhase,
  ChildRequest,
  Failed,
  Listed,
  ListedCase,
  Measured,
  MeasureRequest,
  Ran,
} from "./child-protocol.js";
import type { GcDuringTiming } from "./measure/collections.js";
import type { SamplingReport, Statistics } from "./measure/measure.js";
import { RESULT_FD } from "./result-fd.js";
import { isRecord, thrownMessage } from "./utils.js";

/** How much of a result line that does not answer its request a failure message quotes. */
const QUOTED_LINE_CHARS = 200;

export type Mode = ChildRequest["mode"];

/** The result a child that succeeded gives, by the mode of its request. */
export interface ResultByMode {
  readonly list: Listed;
  readonly measure: Measured;
  readonly once: Ran;
}

/** Every {@link ChildPhase}: a phase missing here fails to compile. */
const CHILD_PHASE_KEYS: Readonly<Record<ChildPhase, true>> = {
  setup: true,
  fn: true,
  teardown: true,
  "optimized-away": true,
  calibration: true,
  child: true,
  load: true,
};

const CHILD_PHASES: ReadonlySet<string> = new Set(Object.keys(CHILD_PHASE_KEYS));

/** Every key of {@link Statistics}: a key missing here fails to compile. */
const STATISTIC_KEYS: Readonly<Record<keyof Statistics, true>> = {
  min: true,
  p25: true,
  median: true,
  p75: true,
  p99: true,
  max: true,
  mean: true,
  sampleCount: true,
};

const STATISTICS = Object.keys(STATISTIC_KEYS);

/** Every numeric key of a child's sampling report: a key missing here fails to compile. */
const SAMPLING_NUMBER_KEYS: Readonly<
  Record<Exclude<keyof SamplingReport, "callsPerSampleFixed">, true>
> = {
  timerResolutionNs: true,
  callsPerSample: true,
  warmupSampleCount: true,
  timingAttemptCount: true,
  timingMs: true,
};

const SAMPLING_NUMBERS = Object.keys(SAMPLING_NUMBER_KEYS);

/** Every key of {@link GcDuringTiming}: a key missing here fails to compile. */
const GC_NUMBER_KEYS: Readonly<Record<keyof GcDuringTiming, true>> = {
  collectionCount: true,
  durationMs: true,
  maxDurationMs: true,
  nodeMinorCollectionCount: true,
  nodeMajorCollectionCount: true,
};

const GC_NUMBERS = Object.keys(GC_NUMBER_KEYS);

/**
 * Reads the result line a child wrote on file descriptor {@link RESULT_FD}.
 *
 * @param written - Everything the child wrote on file descriptor {@link RESULT_FD}.
 * @param request - The child's request: its mode sets the shape the line must have, and a
 *   measurement must answer its `time` and `memory`.
 * @returns The result, or what was wrong with what the child wrote.
 */
export function readResult<R extends ChildRequest>(
  written: string,
  request: R,
): ResultByMode[R["mode"]] | Failed | string {
  if (written === "") return "it wrote no result";
  if (!written.endsWith("\n")) return "its result line has no newline";
  const line = written.slice(0, -1);
  if (line.includes("\n")) {
    return `it wrote ${written.split("\n").length - 1} lines on file descriptor ${RESULT_FD}, not one`;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `its result line is not JSON: ${thrownMessage(error)}`;
  }
  if (isFailed(value)) return value;
  const answers: { readonly [K in Mode]: (value: unknown) => value is ResultByMode[K] } = {
    list: isListed,
    measure: (candidate): candidate is Measured =>
      request.mode === "measure" && isMeasured(candidate, request),
    once: isRan,
  };
  const mode: R["mode"] = request.mode;
  const answer = answers[mode];
  if (answer(value)) return value;
  return `its result line does not answer a ${mode} request: ${line.slice(0, QUOTED_LINE_CHARS)}`;
}

/** Whether `value` is an object whose every `keys` field is a number. */
function hasNumbers(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => typeof value[key] === "number");
}

/** Whether `value` holds a string `message` and a `stack` that is a string or `null`. */
function hasMessageAndStack(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value["message"] === "string" &&
    (value["stack"] === null || typeof value["stack"] === "string")
  );
}

/** Whether `value` is a failed child result: `status` `"failed"` and a well-formed error. */
export function isFailed(value: unknown): value is Failed {
  if (!isRecord(value) || value["status"] !== "failed") return false;
  const { error } = value;
  return (
    hasMessageAndStack(error) &&
    typeof error["phase"] === "string" &&
    CHILD_PHASES.has(error["phase"]) &&
    (error["teardownError"] === null || hasMessageAndStack(error["teardownError"]))
  );
}

function isListedCase(value: unknown): value is ListedCase {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["setupPerCall"] === "boolean" &&
    typeof value["name"] === "string" &&
    (typeof value["contender"] === "string" || value["contender"] === null)
  );
}

function isListed(value: unknown): value is Listed {
  return (
    isRecord(value) &&
    value["status"] === "ok" &&
    Array.isArray(value["cases"]) &&
    value["cases"].every(isListedCase)
  );
}

/**
 * Whether `value` is a measurement answering `asked`: a `time` block exactly when time was asked,
 * and a `memory` that is `null`, or a `memory` block only when memory was asked.
 *
 * @param value - The parsed result line.
 * @param asked - What the request asked the child to read.
 * @returns Whether `value` is that measurement.
 */
function isMeasured(
  value: unknown,
  asked: Pick<MeasureRequest, "time" | "memory">,
): value is Measured {
  if (!isRecord(value) || value["status"] !== "ok") return false;
  const { time, memory } = value;
  return (
    (asked.time ? isMeasuredTime(time) : time === null) &&
    (memory === null || (asked.memory && isMeasuredMemory(memory)))
  );
}

/**
 * Whether `time` holds what a timing child writes.
 *
 * @param time - The parsed result's `time` field.
 * @returns Whether it holds numeric statistics and sampling, its checks, a `gc` block or `null`,
 *   and no raw samples.
 */
function isMeasuredTime(time: unknown): boolean {
  if (!isRecord(time)) return false;
  const { stats, sampling, checks, gc, rawSamples } = time;
  return (
    rawSamples === null &&
    hasNumbers(stats, STATISTICS) &&
    hasNumbers(sampling, SAMPLING_NUMBERS) &&
    typeof sampling["callsPerSampleFixed"] === "boolean" &&
    hasNumbers(checks, ["ratioToEmptyBody"]) &&
    (gc === null || hasNumbers(gc, GC_NUMBERS))
  );
}

/** Whether `memory` is a well-formed `memory` block, its statistics `null` when no pair was clean. */
function isMeasuredMemory(memory: unknown): boolean {
  if (!isRecord(memory)) return false;
  const { stats, sampling, rawSamples } = memory;
  return (
    rawSamples === null &&
    (stats === null || hasNumbers(stats, STATISTICS)) &&
    hasNumbers(sampling, ["callsPerSample"])
  );
}

/** Whether `value` is a once child's result: `status` `"ok"` and nothing else. */
function isRan(value: unknown): value is Ran {
  return isRecord(value) && value["status"] === "ok" && Object.keys(value).length === 1;
}
