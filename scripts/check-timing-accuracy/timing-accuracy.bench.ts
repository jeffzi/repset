// The timing accuracy check's bench file. Each body registers twice: its repset case, which repset's
// side measures, and its baseline case, which the check runs as a `once` request on repset's own
// child entry, `dist/child.js`. Both sides' processes load this one file, so they differ only in
// the code around the timed body call.
//
// `bench` and the loop's helpers come from the built entry, so a child loads one copy of repset, the
// built one, as a user's child does.
import { bench } from "../../dist/index.js";
import { exposedGc, summarize } from "../../dist/measure/measure.js";
import { WARMUP_MIN_MS, WARMUP_MIN_SAMPLES } from "../../dist/measure/sampler.js";
import {
  BASELINE_CALLS_VAR,
  BASELINE_SAMPLES_VAR,
  BODIES,
  BODY_NAMES,
  baselineName,
  benchName,
  buildState,
  positionSum,
  type State,
} from "./bodies.js";

declare global {
  /** Holds the moved positions after timing, so no engine treats the body's work as dead. */
  var benchSink: number | undefined;
}

/** The part of Bun's `bun:jsc` module the baseline uses. */
interface BunJsc {
  readonly noInline: (fn: (...args: never[]) => unknown) => void;
}

/** Whether `value` holds a `noInline` function, as Bun's `bun:jsc` module does. */
function isBunJsc(value: object | undefined): value is BunJsc {
  return value !== undefined && "noInline" in value && typeof value.noInline === "function";
}

/**
 * Reads one of the baseline's counts from the environment.
 *
 * @param name - The environment variable that holds the count.
 * @returns The count.
 * @throws Error naming `name` when the variable is missing or not a positive integer.
 */
function countFromEnv(name: string): number {
  const text = process.env[name];
  const count = Number(text);
  if (text === undefined || text === "" || !Number.isSafeInteger(count) || count < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(text)}`);
  }
  return count;
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
 * Times `body` in a bare loop and prints `{"median": <ns per call>}` on stdout.
 *
 * It warms the body with the timed loop's own batches until both repset's warmup time and warmup
 * batch floor have passed, collects once, then times the samples. The loops stay inline here,
 * since this function is the baseline: a helper around the inner loop changes the code the body
 * call runs inside. Under Bun it keeps the body out of line with `bun:jsc`'s `noInline`, loaded
 * here and never through repset, so a repset that stops keeping its body out of line moves
 * repset's reading alone; under Node it applies nothing.
 *
 * @param body - The body to time.
 * @param state - The points the body moves.
 * @throws Error naming the variable when a count in the environment is missing or not a positive
 *   integer.
 * @throws Error when Bun is running and `bun:jsc` holds no `noInline` function.
 * @throws MeasureError when the process was started without an exposed collector.
 * @throws Whatever the collector or the body throws, unwrapped.
 */
// fallow-ignore-next-line complexity -- the baseline's loops stay inline; see the doc comment
function timeBare(body: (state: State) => void, state: State): void {
  const calls = countFromEnv(BASELINE_CALLS_VAR);
  const samples = countFromEnv(BASELINE_SAMPLES_VAR);
  const gc = exposedGc();
  if ("Bun" in globalThis) {
    // A case's `fn` returns synchronously, so `bun:jsc` loads here without `await import`.
    const jsc = process.getBuiltinModule("bun:jsc");
    if (!isBunJsc(jsc)) throw new Error("bun:jsc holds no noInline function");
    jsc.noInline(body);
  }
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
  globalThis.benchSink = positionSum(state);
  const { median } = summarize(spans, samples, calls);
  process.stdout.write(`${JSON.stringify({ median })}\n`);
}

for (const name of BODY_NAMES) {
  const body = BODIES[name];
  bench(benchName(name), { setup: buildState, fn: body });
  bench(baselineName(name), {
    setup: buildState,
    fn: (state) => {
      timeBare(body, state);
    },
  });
}
