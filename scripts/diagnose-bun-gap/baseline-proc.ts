// fallow-ignore-file code-duplication -- a deliberate copy of the baseline child that differs by one
// measured change; a shared helper would itself be a difference.

// The Bun gap diagnosis's `baseline-proc` child: the timing accuracy check's baseline child plus a
// read of `/proc/<pid>/stat` before and after timing, as the variant child reads it. Everything else
// is `../check-timing-accuracy/baseline-child.ts` statement for statement. It prints
// `{"median": <ns per call>, "cpuStart": <cpu | null>, "cpuEnd": <cpu | null>}` on stdout.
//
//   bun --expose-gc baseline-proc.ts <body> <calls per sample> <samples>
//
// The `/proc` reader is the variant child's `lastCpu`, copied: importing it would load a module the
// baseline child never loads, a second difference.
import { readFileSync } from "node:fs";

import { exposedGc, summarize } from "../../src/measure/measure.js";
import { WARMUP_MIN_MS, WARMUP_MIN_SAMPLES } from "../../src/measure/sampler.js";
import {
  BODIES,
  BODY_NAMES,
  type BodyName,
  buildState,
  positionSum,
  type State,
} from "../check-timing-accuracy/bodies.js";

declare global {
  /** Holds the moved positions after timing, so no engine treats the body's work as dead. */
  var benchSink: number | undefined;
}

/** Index of `processor` (field 39 of `/proc/<pid>/stat`) among the fields after the command name. */
const PROCESSOR_INDEX_AFTER_NAME = 36;

/**
 * Reads the CPU a process last ran on from Linux's `/proc/<pid>/stat`.
 *
 * The command name sits between the first `(` and the last `)` of the line and may hold spaces and
 * parentheses itself, so the fields are counted from the last `)`.
 *
 * @param pid - The process to look up.
 * @param readText - Returns the text of the file at a path; throws an `ENOENT` error when the file
 *   does not exist.
 * @returns The `processor` field, or `null` when the stat file does not exist (no `/proc`, or the
 *   process is gone).
 * @throws Error naming the line read, when it holds too few fields after the command name or its
 *   `processor` field is not a non-negative integer.
 * @throws Whatever `readText` throws other than an `ENOENT` error, unwrapped.
 */
// fallow-ignore-next-line complexity -- a copy of the variant child's `lastCpu`, whose own tests cover it; see the file header
function lastCpu(pid: number, readText: (path: string) => string): number | null {
  let line: string;
  try {
    line = readText(`/proc/${pid}/stat`).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const nameEnd = line.lastIndexOf(")");
  const afterName = nameEnd === -1 ? "" : line.slice(nameEnd + 1);
  const processor = afterName.trim().split(/\s+/)[PROCESSOR_INDEX_AFTER_NAME];
  if (processor === undefined || !/^\d+$/.test(processor)) {
    throw new Error(`no processor field in /proc/${pid}/stat line '${line}'`);
  }
  return Number(processor);
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

const [name = "", callsArg = "", samplesArg = ""] = process.argv.slice(2);
const calls = Number(callsArg);
const samples = Number(samplesArg);
if (!isBodyName(name)) throw new Error(`unknown body '${name}': expected ${BODY_NAMES.join(", ")}`);
if (!isPositiveInteger(calls)) throw new Error(`bad calls per sample '${callsArg}'`);
if (!isPositiveInteger(samples)) throw new Error(`bad sample count '${samplesArg}'`);
const collect = exposedGc();

const body = BODIES[name];
// As the baseline child: its own `noInline`, never repset's `runtimeNoInline`.
if ("Bun" in globalThis) {
  const { noInline } = await import("bun:jsc");
  noInline(body);
}

function isBodyName(value: string): value is BodyName {
  return BODY_NAMES.some((known) => known === value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Runs a minor collection, then a full one: the baseline child's own copy of repset's
 * `collectGarbage`.
 *
 * @param gc - The engine's exposed collector.
 * @throws Whatever the collector throws, unwrapped.
 */
function collectGarbage(gc: NodeJS.GCFunction): void {
  gc({ type: "minor" });
  gc();
}

/**
 * Warms the body with the timed loop's own batches until both repset's warmup time and warmup
 * batch floor have passed, collects once, then times `samples` batches: the baseline child's `run`.
 *
 * @param state - The points the body moves.
 * @param gc - The engine's exposed collector.
 * @returns Each timed batch's span in milliseconds, in the order the batches ran.
 * @throws Whatever the exposed collector or the body throws, unwrapped.
 */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function run(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    spans[sample] = performance.now() - start;
  }
  return spans;
}

const state = buildState();
const cpuStart = lastCpu(process.pid, readUtf8);
const spans = run(state, collect);
const cpuEnd = lastCpu(process.pid, readUtf8);
globalThis.benchSink = positionSum(state);
const { median } = summarize(spans, samples, calls);
process.stdout.write(`${JSON.stringify({ median, cpuStart, cpuEnd })}\n`);
