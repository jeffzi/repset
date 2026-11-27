// fallow-ignore-file code-duplication -- a deliberate copy of the baseline child that differs by one
// measured change; a shared helper would itself be a difference.

// The Bun gap diagnosis's `baseline-table` child: the timing accuracy check's baseline child calling
// `run` through a one-entry table, as the variant child calls its timer through `TIMERS`. Everything
// else is `baseline-child.ts` statement for statement. It prints
// `{"median": <ns per call>}` on stdout.
//
//   bun --expose-gc baseline-table.ts <body> <calls per sample> <samples>
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

/** The one timer, keyed as the variant child keys `TIMERS`. */
const TIMERS: Readonly<Record<"run", (state: State, gc: NodeJS.GCFunction) => Float64Array>> = {
  run,
};
const timerName = "run";

const state = buildState();
const spans = TIMERS[timerName](state, collect);
globalThis.benchSink = positionSum(state);
const { median } = summarize(spans, samples, calls);
process.stdout.write(`${JSON.stringify({ median })}\n`);
