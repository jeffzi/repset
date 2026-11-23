// The timing accuracy check's baseline: one body timed in a bare loop, nothing around the body call
// but the loop and the clock reads. It runs at the calls per sample and sample count repset's child
// reported, and prints `{"median": <ns per call>}` on stdout.
//
//   <node --import tsx | bun> --expose-gc baseline-child.ts <body> <calls per sample> <samples>
import { exposedGc, summarize } from "../../src/measure/measure.js";
import { WARMUP_MIN_MS, WARMUP_MIN_SAMPLES } from "../../src/measure/sampler.js";
import {
  BODIES,
  BODY_NAMES,
  type BodyName,
  buildState,
  positionSum,
  type State,
} from "./bodies.js";

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
// The baseline loads Bun's `noInline` itself, never through repset's `runtimeNoInline`: the check
// compares repset with this loop, so a repset that stops keeping its body out of line must move
// repset's reading alone.
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
 * Runs a minor collection, then a full one, as repset does before its timed samples.
 *
 * The baseline runs its own copy of repset's `collectGarbage`, never the import: the check compares
 * repset with this loop, so a change to how repset collects must move repset's reading alone.
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
 * batch floor have passed, collects once, then times `samples` batches.
 *
 * The loops live in a function: top-level loops run several times slower on Node. Both stay
 * inline here, since this function is the baseline: a helper around the inner loop changes the code
 * the body call runs inside.
 *
 * @param state - The points the body moves.
 * @param gc - The engine's exposed collector.
 * @returns Each timed batch's span in milliseconds, in the order the batches ran.
 * @throws Whatever the exposed collector or the body throws, unwrapped.
 */
// fallow-ignore-next-line complexity -- the baseline's loops stay inline; see the doc comment
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
const spans = run(state, collect);
globalThis.benchSink = positionSum(state);
const { median } = summarize(spans, samples, calls);
process.stdout.write(`${JSON.stringify({ median })}\n`);
