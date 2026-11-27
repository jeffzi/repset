// fallow-ignore-file code-duplication -- each variant is a deliberate near-copy of the baseline
// child's loop that differs by one measured change; a shared helper would itself be a difference.

// The Bun gap diagnosis's variant child: one body timed by one variant of the timing accuracy check's
// baseline loop, at the calls per sample and sample count the driver gives. It prints one JSON line:
// the median, the medians of the first and second half of the samples, p75 and p99, all in ns per
// call, the sample count, and the CPU the process ran on before and after timing.
//
//   <node --import tsx | bun> --expose-gc variant-child.ts <variant> <body> <calls> <samples>
//
// Importing it runs nothing. Each variant is written out in full: `none` is a copy of
// `baseline-child.ts`'s loop, and every other variant differs from `none` by
// the one change its name says, so a shared helper would itself be a difference.
import { readFileSync } from "node:fs";

import {
  collectGarbage as repsetCollectGarbage,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_MIN_TIME,
  exposedGc,
  summarize,
} from "../../src/measure/measure.js";
import { WARMUP_MIN_MS, WARMUP_MIN_SAMPLES } from "../../src/measure/sampler.js";
import { timerResolutionMs } from "../../src/utils.js";
import {
  BODIES,
  BODY_NAMES,
  type BodyName,
  buildState,
  positionSum,
  type State,
} from "../check-timing-accuracy/bodies.js";
import { isVariant, VARIANTS, type Variant } from "./variants.js";

declare global {
  /** Holds what the timed loops leave behind, so no engine treats the body's work as dead. */
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
export function lastCpu(pid: number, readText: (path: string) => string): number | null {
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

// ---------------------------------------------------------------------------
// Arguments, as module constants the way the baseline child holds them
// ---------------------------------------------------------------------------

const [variantArg = "", nameArg = "", callsArg = "", samplesArg = ""] = import.meta.main
  ? process.argv.slice(2)
  : [];
const calls = Number(callsArg);
const samples = Number(samplesArg);
// Typed as repset types `fn`, so `stored-result` can keep what each call returns.
const body: (state: State) => unknown = BODIES[isBodyName(nameArg) ? nameArg : "each"];

function isBodyName(value: string): value is BodyName {
  return BODY_NAMES.some((known) => known === value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Runs a minor collection, then a full one: the baseline child's own copy of repset's
 * `collectGarbage`, so `none` collects exactly as the baseline does.
 *
 * @param gc - The engine's exposed collector.
 * @throws Whatever the collector throws, unwrapped.
 */
function collectGarbage(gc: NodeJS.GCFunction): void {
  gc({ type: "minor" });
  gc();
}

/** The repset clock's shape: `performance.now` behind a function, as `measure.ts` passes it. */
function performanceNow(): number {
  return performance.now();
}

/** Where `stored-result` and `all-six` keep the last call's result, as the sampler does. */
const consumed: { value: unknown } = { value: undefined };

// ---------------------------------------------------------------------------
// `none` and the six single differences
// ---------------------------------------------------------------------------

// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function none(state: State, gc: NodeJS.GCFunction): Float64Array {
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

/** `none`, reading the clock through a function passed in, as `sharedStateSample` does. */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function clockWrapper(state: State, gc: NodeJS.GCFunction, now: () => number): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const start = now();
    for (let call = 0; call < calls; call++) body(state);
    spans[sample] = now() - start;
  }
  return spans;
}

/** One timed sample in a function of its own, called once per sample. */
function oneSample(state: State): number {
  const start = performance.now();
  for (let call = 0; call < calls; call++) body(state);
  return performance.now() - start;
}

/** `none`, taking each timed sample through {@link oneSample}. */
function sampleFunction(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) spans[sample] = oneSample(state);
  return spans;
}

/** `none`, keeping each call's result and storing the last after each sample's clock read. */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function storedResult(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    let last: unknown;
    const start = performance.now();
    for (let call = 0; call < calls; call++) last = body(state);
    spans[sample] = performance.now() - start;
    consumed.value = last;
  }
  return spans;
}

/** The body and its state behind an object, as the sampler's `timed` holds them. */
interface Timed {
  readonly fn: (state: State) => unknown;
  readonly state: State;
}

/** `none`, reaching the body and state through an object and the count through an argument. */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function indirectAccess(
  state: State,
  timed: Timed,
  count: number,
  gc: NodeJS.GCFunction,
): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const { fn, state: timedState } = timed;
    const start = performance.now();
    for (let call = 0; call < count; call++) fn(timedState);
    spans[sample] = performance.now() - start;
  }
  return spans;
}

/** `none`, deciding each next sample on a clock read against repset's `minTime` and `minSamples`. */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function clockBetweenSamples(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  let stored = 0;
  const started = performance.now();
  while (stored < DEFAULT_MIN_SAMPLES || performance.now() - started < DEFAULT_MIN_TIME) {
    if (stored === spans.length) break;
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    spans[stored] = performance.now() - start;
    stored += 1;
  }
  return spans.subarray(0, stored);
}

/** `none`, warming up through timed samples and keeping the shortest, as the sampler's warmup does. */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function timedWarmup(state: State, gc: NodeJS.GCFunction): Float64Array {
  let warmed = 0;
  let shortest = 0;
  const warmStart = performance.now();
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() - warmStart < WARMUP_MIN_MS) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    const span = performance.now() - start;
    if (span > 0 && (shortest === 0 || span < shortest)) shortest = span;
    warmed += 1;
  }
  globalThis.benchSink = shortest;
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    spans[sample] = performance.now() - start;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// All six, and the three sides around the loop
// ---------------------------------------------------------------------------

/** The sampler's `timed`: the clock, the body and its state. */
interface TimedWithClock extends Timed {
  readonly now: () => number;
}

/** One sample in `sharedStateSample`'s shape: clock wrapper, object access, stored result. */
function allSixSample(timed: TimedWithClock, count: number): number {
  const { now, fn, state } = timed;
  let last: unknown;
  const started = now();
  for (let call = 0; call < count; call++) last = fn(state);
  const spanMs = now() - started;
  consumed.value = last;
  return spanMs;
}

/** Every one of the six differences at once: repset's shared-state loop shape at a fixed count. */
function allSix(timed: TimedWithClock, count: number, gc: NodeJS.GCFunction): Float64Array {
  const { now } = timed;
  let warmed = 0;
  let shortest = 0;
  const warmStart = now();
  while (warmed < WARMUP_MIN_SAMPLES || now() - warmStart < WARMUP_MIN_MS) {
    const span = allSixSample(timed, count);
    if (span > 0 && (shortest === 0 || span < shortest)) shortest = span;
    warmed += 1;
  }
  globalThis.benchSink = shortest;
  collectGarbage(gc);
  const spans = new Float64Array(samples);
  let stored = 0;
  const started = now();
  while (stored < DEFAULT_MIN_SAMPLES || now() - started < DEFAULT_MIN_TIME) {
    if (stored === spans.length) break;
    spans[stored] = allSixSample(timed, count);
    stored += 1;
  }
  return spans.subarray(0, stored);
}

/**
 * `none`, with its spans in a store about as large as repset's at a fixed count.
 *
 * Repset sizes its store `ceil(minTime / shortest warmup sample) + minSamples` (the store sizing
 * in `sampleSharedState`, `src/measure/sampler.ts`). Timing each warmup batch to find the shortest
 * would add the `timed-warmup` difference, so this variant takes warmup's mean batch instead, from
 * one clock read after warmup. The mean is never below the shortest, so the store can come out
 * somewhat smaller than repset's; it never holds fewer than `samples` spans.
 */
// fallow-ignore-next-line complexity -- a copy of the baseline child's loops; see the file header
function repsetBuffer(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmStart = performance.now();
  const warmEnd = warmStart + WARMUP_MIN_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_SAMPLES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  const meanBatchMs = (performance.now() - warmStart) / warmed;
  collectGarbage(gc);
  const capacity = Math.ceil(DEFAULT_MIN_TIME / meanBatchMs) + DEFAULT_MIN_SAMPLES;
  const spans = new Float64Array(Math.max(capacity, samples));
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    spans[sample] = performance.now() - start;
  }
  return spans.subarray(0, samples);
}

/**
 * Times the body through repset's own built shared-state sampler at the fixed count, with the
 * clock, resolution, collection, `minTime` and `minSamples` repset's child gives it
 * (the `sampleSharedState` call in `measure`, `src/measure/measure.ts`). Its sample count is the sampler's own, not `samples`.
 */
async function repsetSampler(state: State, gc: NodeJS.GCFunction): Promise<Float64Array> {
  const { sampleSharedState } = await import("../../dist/measure/sampler.js");
  const run = sampleSharedState({
    now: performanceNow,
    resolutionMs: timerResolutionMs(performanceNow),
    callsPerSample: calls,
    collect: () => {
      repsetCollectGarbage(gc);
    },
    fn: body,
    state,
    minTime: DEFAULT_MIN_TIME,
    minSamples: DEFAULT_MIN_SAMPLES,
  });
  return run.spans.subarray(0, run.sampleCount);
}

/** The variant child's view of the timing loops: the state, then the exposed collector. */
type TimeVariant = (state: State, gc: NodeJS.GCFunction) => Float64Array | Promise<Float64Array>;

/**
 * Loads the built entry and the bench file, as repset's child loads them before it measures, then
 * times `none`.
 *
 * @param state - The points the body moves.
 * @param gc - The engine's exposed collector.
 * @returns The timed spans in milliseconds, in the order they ran.
 * @throws Whatever an import, the collector or the body throws, unwrapped.
 */
async function repsetLoaded(state: State, gc: NodeJS.GCFunction): Promise<Float64Array> {
  await import("../../dist/index.js");
  await import("../check-timing-accuracy/timing-accuracy.bench.js");
  return none(state, gc);
}

/** How each variant times the body. */
const TIMERS: Readonly<Record<Variant, TimeVariant>> = {
  none,
  "clock-wrapper": (state, gc) => clockWrapper(state, gc, performanceNow),
  "sample-function": sampleFunction,
  "stored-result": storedResult,
  "indirect-access": (state, gc) => indirectAccess(state, { fn: body, state }, calls, gc),
  "clock-between-samples": clockBetweenSamples,
  "timed-warmup": timedWarmup,
  "all-six": (state, gc) => allSix({ now: performanceNow, fn: body, state }, calls, gc),
  "repset-buffer": repsetBuffer,
  "repset-loaded": repsetLoaded,
  "repset-sampler": repsetSampler,
};

/**
 * Checks the arguments, times the variant and prints its line.
 *
 * @throws Error naming the bad argument when the variant, body, calls or samples are not valid.
 * @throws Whatever timing or reading the CPU throws.
 */
async function main(): Promise<void> {
  if (!isVariant(variantArg)) {
    throw new Error(`unknown variant '${variantArg}': expected ${VARIANTS.join(", ")}`);
  }
  if (!isBodyName(nameArg)) {
    throw new Error(`unknown body '${nameArg}': expected ${BODY_NAMES.join(", ")}`);
  }
  if (!isPositiveInteger(calls)) throw new Error(`bad calls per sample '${callsArg}'`);
  // Two at least, so each half of the samples has a median.
  if (!isPositiveInteger(samples) || samples < 2) {
    throw new Error(`bad sample count '${samplesArg}': expected an integer of 2 or more`);
  }
  const gc = exposedGc();
  // As the baseline child: its own `noInline`, never repset's `runtimeNoInline`.
  if ("Bun" in globalThis) {
    const { noInline } = await import("bun:jsc");
    noInline(body);
  }
  const state = buildState();
  const cpuStart = lastCpu(process.pid, readUtf8);
  const spans = await TIMERS[variantArg](state, gc);
  const cpuEnd = lastCpu(process.pid, readUtf8);
  globalThis.benchSink = positionSum(state);
  const half = Math.floor(spans.length / 2);
  const all = summarize(spans, spans.length, calls);
  const line = {
    median: all.median,
    firstHalfMedian: summarize(spans.subarray(0, half), half, calls).median,
    secondHalfMedian: summarize(spans.subarray(half), spans.length - half, calls).median,
    p75: all.p75,
    p99: all.p99,
    sampleCount: spans.length,
    cpuStart,
    cpuEnd,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

if (import.meta.main) await main();
