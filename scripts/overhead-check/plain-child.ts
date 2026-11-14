// The overhead check's control: one body timed in a hand-written loop, nothing around the body
// call but the loop and the clock reads. It runs at the calls per sample and sample count
// repset's child reported, and prints `{"median": <ns per call>}` on stdout.
//
//   <node --import tsx | bun> --expose-gc plain-child.ts <body> <calls per sample> <samples>
import {
  BODIES,
  BODY_NAMES,
  type BodyName,
  buildPoints,
  type Points,
  positionSum,
} from "./bodies.js";

declare global {
  /** Holds the moved positions after timing, so no engine treats the body's work as dead. */
  var benchSink: number | undefined;
}

/** How long warmup runs before timing starts, repset's warmup length. */
const WARMUP_MS = 250;

const NS_PER_MS = 1e6;

const [name = "", callsArg = "", samplesArg = ""] = process.argv.slice(2);
const calls = Number(callsArg);
const samples = Number(samplesArg);
if (!isBodyName(name)) throw new Error(`unknown body '${name}': expected ${BODY_NAMES.join(", ")}`);
if (!Number.isSafeInteger(calls) || calls < 1)
  throw new Error(`bad calls per sample '${callsArg}'`);
if (!Number.isSafeInteger(samples) || samples < 1)
  throw new Error(`bad sample count '${samplesArg}'`);
const collect = globalThis.gc;
if (typeof collect !== "function") throw new Error("run with --expose-gc");

const body = BODIES[name];
if (process.versions["bun"] !== undefined) (await import("bun:jsc")).noInline(body);

function isBodyName(value: string): value is BodyName {
  return BODY_NAMES.some((known) => known === value);
}

/**
 * Warms the body with the timed loop's own batches, collects once, then times `samples` batches.
 *
 * The loops live in a function: top-level loops run several times slower on Node. Both stay
 * inline here, since this function is the control: a helper around the inner loop changes the code
 * the body call runs inside.
 *
 * @param state - The points the body moves.
 * @param gc - The engine's exposed collector.
 * @returns Each timed batch's per-call time in nanoseconds, ascending.
 */
// fallow-ignore-next-line complexity -- the control's loops stay inline; see the doc comment
function run(state: Points, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MS;
  while (performance.now() < warmEnd) for (let call = 0; call < calls; call++) body(state);
  gc();
  const perCall = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    perCall[sample] = ((performance.now() - start) * NS_PER_MS) / calls;
  }
  return perCall.toSorted();
}

const state = buildPoints();
const perCall = run(state, collect);
globalThis.benchSink = positionSum(state);
const rank = (samples - 1) * 0.5;
const low = perCall[Math.floor(rank)] ?? Number.NaN;
const high = perCall[Math.ceil(rank)] ?? Number.NaN;
process.stdout.write(
  `${JSON.stringify({ median: low + (high - low) * (rank - Math.floor(rank)) })}\n`,
);
