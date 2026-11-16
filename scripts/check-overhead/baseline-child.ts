// The overhead check's baseline: one body timed in a bare loop, nothing around the body call but
// the loop and the clock reads. It runs at the calls per sample and sample count repset's child
// reported, and prints `{"median": <ns per call>}` on stdout.
//
//   <node --import tsx | bun> --expose-gc baseline-child.ts <body> <calls per sample> <samples>
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

/** How long warmup runs before timing starts, repset's warmup length. */
const WARMUP_MS = 250;

/** The fewest warmup batches before timing starts, repset's warmup floor. */
const WARMUP_MIN_BATCHES = 16;

const NS_PER_MS = 1e6;

const MEDIAN_QUANTILE = 0.5;

const [name = "", callsArg = "", samplesArg = ""] = process.argv.slice(2);
const calls = Number(callsArg);
const samples = Number(samplesArg);
if (!isBodyName(name)) throw new Error(`unknown body '${name}': expected ${BODY_NAMES.join(", ")}`);
if (!isPositiveInteger(calls)) throw new Error(`bad calls per sample '${callsArg}'`);
if (!isPositiveInteger(samples)) throw new Error(`bad sample count '${samplesArg}'`);
const collect = globalThis.gc;
if (typeof collect !== "function") throw new Error("run with --expose-gc");

const body = BODIES[name];
if (process.versions["bun"] !== undefined) (await import("bun:jsc")).noInline(body);

function isBodyName(value: string): value is BodyName {
  return BODY_NAMES.some((known) => known === value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Reads one rank of the ascending per-call times.
 *
 * @param sorted - The per-call times, ascending.
 * @param rank - The zero-based rank to read.
 * @returns The time at that rank.
 * @throws RangeError when no time is stored at that rank.
 */
function timeAt(sorted: Float64Array, rank: number): number {
  const time = sorted[rank];
  if (time === undefined) {
    throw new RangeError(`no timed batch at rank ${String(rank)}: ${String(sorted.length)} timed`);
  }
  return time;
}

/**
 * Warms the body with the timed loop's own batches until both 250 ms and 16 batches have passed,
 * collects once, then times `samples` batches.
 *
 * The loops live in a function: top-level loops run several times slower on Node. Both stay
 * inline here, since this function is the baseline: a helper around the inner loop changes the code
 * the body call runs inside.
 *
 * @param state - The points the body moves.
 * @param gc - The engine's exposed collector.
 * @returns Each timed batch's per-call time in nanoseconds, ascending.
 */
// fallow-ignore-next-line complexity -- the baseline's loops stay inline; see the doc comment
function run(state: State, gc: NodeJS.GCFunction): Float64Array {
  const warmEnd = performance.now() + WARMUP_MS;
  let warmed = 0;
  while (warmed < WARMUP_MIN_BATCHES || performance.now() < warmEnd) {
    for (let call = 0; call < calls; call++) body(state);
    warmed += 1;
  }
  gc();
  const perCall = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) body(state);
    perCall[sample] = ((performance.now() - start) * NS_PER_MS) / calls;
  }
  return perCall.toSorted();
}

const state = buildState();
const perCall = run(state, collect);
globalThis.benchSink = positionSum(state);
const rank = (samples - 1) * MEDIAN_QUANTILE;
const lowerRank = Math.floor(rank);
const low = timeAt(perCall, lowerRank);
const high = timeAt(perCall, Math.ceil(rank));
const median = low + (high - low) * (rank - lowerRank);
process.stdout.write(`${JSON.stringify({ median })}\n`);
