/**
 * The child entry: a process the parent starts on Node or Bun to load one benchmark file and list
 * its cases, measure one case, or run one case once, reading the cases the file registered through
 * `bench()`.
 *
 * A measuring child loads this module beside the benchmark, so it imports only the `measure`
 * modules, `bench`, `child-protocol`, `result-fd`, the generic helpers in `utils` and Node builtins:
 * under Bun, module code a child loads slows the timed calls even when it never runs.
 */
import { existsSync, realpathSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type RegisteredCase, registeredCases } from "./bench.js";
import {
  type ChildRequest,
  type ChildResult,
  type Failed,
  failedResult,
  type Listed,
  type Measured,
  type MeasuredMemory,
  type MeasureRequest,
  parseRequest,
  type Ran,
} from "./child-protocol.js";
import {
  type Case,
  collectGarbage,
  exposedGc,
  failedIn,
  keep,
  measure,
  MeasureError,
  type Phase,
  requireSynchronous,
  statisticsOfSorted,
  tearDownCatching,
  withCaseState,
} from "./measure/measure.js";
import { runningRuntime } from "./measure/runtime.js";
import { RESULT_FD } from "./result-fd.js";
import { valueAt } from "./utils.js";

// ---------------------------------------------------------------------------
// Loading and running cases
// ---------------------------------------------------------------------------

/**
 * Lists the cases a benchmark file registers, in registration order.
 *
 * The file is imported by its file URL, so a Windows path loads too, and its top-level `await`
 * finishes before the registry is read. A file imported earlier in the same process does not
 * register again.
 *
 * @param file - The benchmark file's absolute path.
 * @returns Every registered case, a twice-registered id twice, or a failure in phase `load` when the
 *   import throws or rejects or the registry cannot be read.
 */
export async function listCases(file: string): Promise<Listed | Failed> {
  try {
    const cases = (await loadCases(file)).map(({ id, name, contender, case: registered }) => ({
      id,
      setupPerCall: registered.kind === "perCall",
      name,
      contender,
    }));
    return { status: "ok", cases };
  } catch (error) {
    return failedResult("load", error);
  }
}

/**
 * Measures the case `id` of a benchmark file; the file's other cases register but never run.
 *
 * The memory pass runs after timing, and only on Node: Bun has no heap reading.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to measure.
 * @param request - Whether to time the case and read its memory; for timing, the time in
 *   milliseconds and the sample count the body's timing must pass, and the calls per sample to
 *   measure at, calibrated when absent.
 * @param probe - The memory pass's heap reading and collection detector, the real ones when absent.
 * @returns The `time` and `memory` blocks of the report's measurement entry, or a failure: in phase
 *   `load` when the file fails to load or `id` does not select exactly one case, otherwise in the
 *   phase timing or the memory pass failed in. A failed timing runs no pass.
 */
export async function measureCase(
  file: string,
  id: string,
  request: Pick<MeasureRequest, "minTime" | "minSamples" | "callsPerSample" | "time" | "memory">,
  probe: MemoryProbe = {},
): Promise<Measured | Failed> {
  return withSelectedCase(file, id, async (selected): Promise<Measured> => {
    const time = request.time ? { ...(await measure(selected, request)), rawSamples: null } : null;
    const memory =
      request.memory && runningRuntime() === "node" ? await measureMemory(selected, probe) : null;
    return { status: "ok", time, memory };
  });
}

/**
 * Runs the case `id` of a benchmark file once: one `setup`, one `fn` call and one `teardown`, with
 * no timing and no collector, so it runs on a runtime that cannot measure.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to run.
 * @returns A success, or a failure: in phase `load` when the file fails to load or `id` does not
 *   select exactly one case, otherwise in the phase of the callback that failed.
 */
export async function runOnce(file: string, id: string): Promise<Ran | Failed> {
  return withSelectedCase(file, id, (selected): Ran => {
    withCaseState(selected, () => undefined);
    return { status: "ok" };
  });
}

/**
 * Imports a benchmark file by its file URL and reads what it registered.
 *
 * @param file - The benchmark file's absolute path.
 * @returns The registered cases, once the file's top-level `await` has finished.
 * @throws The value the import threw or rejected with, or the registry's TypeError.
 */
async function loadCases(file: string): Promise<readonly RegisteredCase[]> {
  await import(pathToFileURL(file).href);
  return registeredCases();
}

/**
 * Picks the case `id` of a benchmark file and runs `work` on it, encoding either failure as a result.
 *
 * @param file - The benchmark file's absolute path.
 * @param id - The case to pick.
 * @param work - Runs on the selected case; it may be asynchronous.
 * @returns What `work` returned, or a failure: in phase `load` when the file fails to load or `id`
 *   does not select exactly one case, otherwise in the phase `work` failed in.
 */
async function withSelectedCase<T>(
  file: string,
  id: string,
  work: (selected: Case<unknown>) => T | Promise<T>,
): Promise<T | Failed> {
  let selected: Case<unknown>;
  try {
    const matches = (await loadCases(file)).filter((registered) => registered.id === id);
    const [match] = matches;
    if (match === undefined) {
      throw new Error(`no benchmark is registered under the id ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`the id ${id} is registered ${matches.length} times`);
    }
    selected = match.case;
  } catch (error) {
    return failedResult("load", error);
  }
  try {
    return await work(selected);
  } catch (error) {
    // "child" is only the fallback for a value that is not a MeasureError: `work` throws
    // MeasureErrors alone, whose own phase the result carries.
    return failedResult("child", error);
  }
}

// ---------------------------------------------------------------------------
// The memory pass
// ---------------------------------------------------------------------------

// The pass reads the heap before and after a sample of body calls, and again around a sample of as
// many calls of a function that does nothing, in the case's own lifecycle: the paired difference
// cancels the bytes the pass itself allocates per sample. Nothing between a sample's two readings
// may allocate: the readings go into a buffer allocated before the first sample, per-call states
// are built before the first reading, and the calls run in an indexed loop.

/** The calls per sample the pass starts at, before any halving. */
const PASS_CALLS = 64;

/** The clean pairs the pass keeps at one count, and the extra pairs it may take at one call. */
const PASS_PAIRS = 21;

/** Counts the collections that run inside one sample, between its two heap readings. */
export interface CollectionDetector {
  /** Starts counting, after the sample's forced collection and before its first reading. */
  start(): void;
  /** Stops counting, after the sample's second reading, and returns the collections counted. */
  stop(): number;
}

/** What the memory pass reads the heap and detects collections with. */
export interface MemoryProbe {
  /** The heap's used bytes; `process.memoryUsage().heapUsed` when absent. */
  readonly heapUsed?: (() => number) | undefined;
  /** Builds the collection detector; a `node:v8` `GCProfiler` when absent. */
  readonly detector?: (() => Promise<CollectionDetector>) | undefined;
}

/** What the pass's samples share: the collector, the probe and the current sample's readings. */
interface PassWindow {
  readonly gc: NonNullable<typeof globalThis.gc>;
  readonly heapUsed: () => number;
  readonly detector: CollectionDetector;
  readonly readings: Float64Array;
}

/** Takes one body sample or one empty sample of `calls` calls; returns whether it was flagged. */
interface PassSampler {
  readonly body: (calls: number) => boolean;
  readonly empty: (calls: number) => boolean;
}

/**
 * Holds what the last call of the latest shared-state body sample returned, so the engine cannot
 * treat the body's result as dead.
 */
const consumed: { value: unknown } = { value: undefined };

/** Stands in for `fn` in the empty sample, so its loop costs what the body sample's loop costs. */
function emptyBody(): void {
  // Calls nothing and allocates nothing.
}

/** The default {@link MemoryProbe.heapUsed}. */
function processHeapUsed(): number {
  return process.memoryUsage().heapUsed;
}

/**
 * Builds a detector on `node:v8`'s `GCProfiler`, imported only when the pass runs, so a Bun child
 * never loads it.
 *
 * @returns A detector that starts a fresh profiler per sample.
 * @throws The loader's value when `node:v8` cannot be imported.
 */
async function gcProfilerDetector(): Promise<CollectionDetector> {
  const { GCProfiler } = await import("node:v8");
  let profiler: InstanceType<typeof GCProfiler> | undefined;
  return {
    start: () => {
      profiler = new GCProfiler();
      profiler.start();
    },
    stop: () => profiler?.stop().statistics.length ?? 0,
  };
}

/**
 * Reads a case's heap bytes per call.
 *
 * @param benchmark - The case to read.
 * @param probe - The heap reading and the detector builder, the real ones when absent.
 * @returns The `memory` block: the statistics of the kept pairs' differences per call, `null` when
 *   no pair was clean, and the calls per sample they were taken at.
 * @throws MeasureError in phase `child` when no collector is exposed, the detector cannot be built,
 *   or the forced collection, the heap reading or the detector throws.
 * @throws MeasureError in phase `setup`, `fn` or `teardown` when that callback throws or its first
 *   call returns a thenable, with the thrown value unchanged as cause, after every state left alive
 *   is torn down; a cleanup teardown's failure is attached as its `teardownError`.
 */
async function measureMemory<State>(
  benchmark: Case<State>,
  probe: MemoryProbe,
): Promise<MeasuredMemory> {
  const gc = exposedGc();
  let detector: CollectionDetector;
  try {
    detector = await (probe.detector ?? gcProfilerDetector)();
  } catch (error) {
    throw new MeasureError("child", error);
  }
  const window: PassWindow = {
    gc,
    heapUsed: probe.heapUsed ?? processHeapUsed,
    detector,
    readings: new Float64Array(2),
  };
  if (benchmark.kind === "perCall") return passPerCall(benchmark, window);
  return withCaseState(benchmark, (state) =>
    takePairs(sharedStateSampler(benchmark.fn, state, window), window),
  );
}

/**
 * Takes pairs of a body sample and an empty sample until 21 are clean. A flagged pair halves the
 * calls per sample and starts the 21 again; at one call, it is taken again, up to 21 extra pairs.
 *
 * @param sampler - Takes the case's samples.
 * @param window - Holds each sample's readings.
 * @returns The `memory` block of the pairs kept at the final calls per sample.
 * @throws What a sample throws.
 */
function takePairs(sampler: PassSampler, window: PassWindow): MeasuredMemory {
  const differences = new Float64Array(PASS_PAIRS);
  let calls = PASS_CALLS;
  let kept = 0;
  let extras = 0;
  while (kept < PASS_PAIRS) {
    const bodyFlagged = sampler.body(calls);
    const bodyDelta = sampleDelta(window);
    const emptyFlagged = sampler.empty(calls);
    if (!bodyFlagged && !emptyFlagged) {
      differences[kept] = (bodyDelta - sampleDelta(window)) / calls;
      kept++;
    } else if (calls > 1) {
      calls = Math.floor(calls / 2);
      kept = 0;
    } else if (extras < PASS_PAIRS) {
      extras++;
    } else {
      break;
    }
  }
  return {
    stats: kept === 0 ? null : statisticsOfSorted(differences.subarray(0, kept).toSorted()),
    sampling: { callsPerSample: calls },
    rawSamples: null,
  };
}

/** The bytes the last sample's second reading holds over its first. */
function sampleDelta(window: PassWindow): number {
  return valueAt(window.readings, 1) - valueAt(window.readings, 0);
}

/**
 * Forces a collection, starts the detector and takes a sample's first reading.
 *
 * @param window - The collector, the probe and the readings.
 * @throws MeasureError in phase `child` when the collection, the detector or the reading throws.
 */
function openSample(window: PassWindow): void {
  collectGarbage(window.gc);
  try {
    window.detector.start();
    window.readings[0] = window.heapUsed();
  } catch (error) {
    throw new MeasureError("child", error);
  }
}

/**
 * Takes a sample's second reading and stops the detector.
 *
 * @param window - The probe and the readings.
 * @returns Whether the detector counted a collection inside the sample.
 * @throws MeasureError in phase `child` when the reading or the detector throws.
 */
function closeSample(window: PassWindow): boolean {
  try {
    window.readings[1] = window.heapUsed();
    return window.detector.stop() > 0;
  } catch (error) {
    throw new MeasureError("child", error);
  }
}

/**
 * Samples a shared-state case on its one state.
 *
 * @param fn - The body.
 * @param state - The state every call runs on.
 * @param window - The collector, the probe and the readings.
 * @returns The sampler.
 */
function sharedStateSampler<State>(
  fn: (state: State) => unknown,
  state: State,
  window: PassWindow,
): PassSampler {
  return {
    body: (calls) => {
      openSample(window);
      let last: unknown;
      for (let call = 0; call < calls; call++) last = fn(state);
      const flagged = closeSample(window);
      consumed.value = last;
      return flagged;
    },
    empty: (calls) => {
      openSample(window);
      for (let call = 0; call < calls; call++) emptyBody();
      return closeSample(window);
    },
  };
}

/**
 * The states a per-call pass has built and not torn down, and the callback running. Each state sits
 * in a slot of its own, so a state that is `undefined` reads back as one.
 */
interface PerCallRun<State> {
  readonly slots: Array<{ readonly state: State }>;
  built: number;
  phase: Phase;
}

/**
 * Runs the pass on a per-call case: checks its first setup, body and teardown are synchronous, then
 * takes the pairs, each sample building its states before its first reading and tearing them down
 * after its second.
 *
 * @param benchmark - The case.
 * @param window - The collector, the probe and the readings.
 * @returns The `memory` block.
 * @throws MeasureError in the phase of the callback or the collection that failed, after every
 *   state left alive is torn down; a cleanup teardown's failure is attached as its `teardownError`.
 */
function passPerCall<State>(benchmark: Case<State>, window: PassWindow): MeasuredMemory {
  const teardown = benchmark.teardown ?? keep;
  const run: PerCallRun<State> = { slots: [], built: 0, phase: "setup" };
  try {
    buildStates(benchmark.setup, run, 1);
    requireSynchronous(stateAt(run, 0), "setup");
    run.phase = "fn";
    requireSynchronous(benchmark.fn(stateAt(run, 0)), "fn");
    tearDownStates(teardown, run);
    return takePairs(perCallSampler(benchmark, teardown, run, window), window);
  } catch (error) {
    const phase = run.phase;
    throw failedIn(phase, error, tearDownStates(teardown, run, false));
  }
}

/**
 * Samples a per-call case: each sample builds its states before its first reading and tears them
 * down after its second, so it never holds more states than its calls.
 *
 * @param benchmark - The case.
 * @param teardown - The case's teardown, or one that keeps the state.
 * @param run - Holds the states and the callback running, for the caller's cleanup.
 * @param window - The collector, the probe and the readings.
 * @returns The sampler.
 */
function perCallSampler<State>(
  benchmark: Case<State>,
  teardown: (state: State) => unknown,
  run: PerCallRun<State>,
  window: PassWindow,
): PassSampler {
  const { setup, fn } = benchmark;
  return {
    body: (calls) => {
      buildStates(setup, run, calls);
      openSample(window);
      run.phase = "fn";
      for (let call = 0; call < calls; call++) fn(stateAt(run, call));
      const flagged = closeSample(window);
      tearDownStates(teardown, run);
      return flagged;
    },
    empty: (calls) => {
      buildStates(setup, run, calls);
      openSample(window);
      for (let call = 0; call < calls; call++) emptyBody();
      const flagged = closeSample(window);
      tearDownStates(teardown, run);
      return flagged;
    },
  };
}

/**
 * The state `run` built at `index`.
 *
 * @param run - The built states.
 * @param index - A built state's index, below `run.built`.
 * @returns The state, whatever its value.
 * @throws RangeError when no state was built at `index`.
 */
function stateAt<State>(run: PerCallRun<State>, index: number): State {
  return valueAt(run.slots, index).state;
}

/** Builds `calls` states into `run`, counting each as built once its setup returns. */
function buildStates<State>(setup: () => State, run: PerCallRun<State>, calls: number): void {
  run.phase = "setup";
  for (let call = 0; call < calls; call++) {
    run.slots[call] = { state: setup() };
    run.built = call + 1;
  }
}

/**
 * Tears down every state `run` holds, each once, whatever an earlier teardown did.
 *
 * @param teardown - The case's teardown.
 * @param run - The states built and not torn down; none are left afterwards.
 * @param throwing - Whether to throw the first teardown's failure, or hand it back.
 * @returns The first teardown's failure, or `null` when none failed.
 * @throws MeasureError in phase `teardown` when `throwing` and a teardown threw or returned a
 *   thenable.
 */
function tearDownStates<State>(
  teardown: (state: State) => unknown,
  run: PerCallRun<State>,
  throwing = true,
): MeasureError | null {
  const built = run.built;
  run.built = 0;
  run.phase = "teardown";
  let failure: MeasureError | null = null;
  for (let call = 0; call < built; call++) {
    const failed = tearDownCatching(teardown, stateAt(run, call));
    failure ??= failed;
  }
  if (throwing && failure !== null) throw failure;
  return failure;
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every mode, which tsc and switch-exhaustiveness-check enforce
async function respond(request: ChildRequest): Promise<ChildResult> {
  switch (request.mode) {
    case "list":
      return listCases(request.file);
    case "measure":
      return measureCase(request.file, request.id, request);
    case "once":
      return runOnce(request.file, request.id);
  }
}

/** Resolves once everything written to `stream` before the call has been handed off. */
async function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    // A write error (a parent that closed the pipe) must not turn a written result into a failed
    // exit, so it resolves too.
    stream.write("", () => {
      resolve();
    });
  });
}

/** Whether the process was started on this module, compared as real paths so links match. */
function startedOnThisModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !existsSync(entry)) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

/**
 * Answers the request on the command line, writes the result line, and exits.
 *
 * The explicit exit ends the child even when the file left a handle open; it waits for the output
 * streams first, which a piped stream on Node otherwise loses.
 *
 * @throws SyntaxError when the request argument is not JSON.
 * @throws TypeError when {@link parseRequest} rejects the request.
 * @throws Error when writing the result line on {@link RESULT_FD} fails.
 */
async function main(): Promise<void> {
  const result = await respond(parseRequest(process.argv[2] ?? ""));
  writeSync(RESULT_FD, `${JSON.stringify(result)}\n`);
  await flushed(process.stdout);
  await flushed(process.stderr);
  process.exit(0);
}

/** The `globalThis` slot the first copy of this module to answer the request sets. */
const ANSWERING_KEY = Symbol.for("repset.child.answering");

/**
 * Claims the request for this copy of the module. A loader such as tsx can evaluate this module
 * twice in one process, and only one copy may write the result line.
 *
 * @returns `true` for the first copy to ask, `false` for every later one.
 */
function claimAnswer(): boolean {
  if (Reflect.get(globalThis, ANSWERING_KEY) === true) return false;
  Reflect.set(globalThis, ANSWERING_KEY, true);
  return true;
}

// Not awaited at the top level: `main()` imports the benchmark file, so awaiting it here would keep
// this module evaluating until that file finishes loading.
if (startedOnThisModule() && claimAnswer()) void main();
