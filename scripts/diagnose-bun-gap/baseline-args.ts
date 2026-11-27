// fallow-ignore-file code-duplication -- a deliberate copy of the baseline child that differs by one
// measured change; a shared helper would itself be a difference.

// The Bun gap diagnosis's `baseline-args` child: the timing accuracy check's baseline child with its
// arguments parsed as the variant child parses them, into module constants under
// `import.meta.main` with the body falling back to `each`, and checked in a function before timing.
// Everything else is `baseline-child.ts` statement for statement. It
// prints `{"median": <ns per call>}` on stdout.
//
//   bun --expose-gc baseline-args.ts <body> <calls per sample> <samples>
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

const [nameArg = "", callsArg = "", samplesArg = ""] = import.meta.main
  ? process.argv.slice(2)
  : [];
const calls = Number(callsArg);
const samples = Number(samplesArg);
const body = BODIES[isBodyName(nameArg) ? nameArg : "each"];

function isBodyName(value: string): value is BodyName {
  return BODY_NAMES.some((known) => known === value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Checks the body name, calls per sample and sample count, as the variant child's `main` does.
 *
 * @throws Error naming the bad argument when the body, calls or samples are not valid.
 */
function checkArguments(): void {
  if (!isBodyName(nameArg)) {
    throw new Error(`unknown body '${nameArg}': expected ${BODY_NAMES.join(", ")}`);
  }
  if (!isPositiveInteger(calls)) throw new Error(`bad calls per sample '${callsArg}'`);
  if (!isPositiveInteger(samples)) throw new Error(`bad sample count '${samplesArg}'`);
}

checkArguments();
const collect = exposedGc();

// As the baseline child: its own `noInline`, never repset's `runtimeNoInline`.
if ("Bun" in globalThis) {
  const { noInline } = await import("bun:jsc");
  noInline(body);
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
const spans = run(state, collect);
globalThis.benchSink = positionSum(state);
const { median } = summarize(spans, samples, calls);
process.stdout.write(`${JSON.stringify({ median })}\n`);
