/**
 * `measure`: runs one benchmark's lifecycle through its sampler and returns its per-call
 * statistics.
 *
 * The samplers are plain synchronous loops with no `try` anywhere above the timed calls; the error
 * rules (tear down every context left alive, keep the first thrown value) live here, in their
 * caller, so a `try` never reaches the compile of a sampling loop.
 *
 * The module reads no Node builtin, so it loads in a browser page; `bun:jsc` is imported only
 * under Bun.
 */

import { empty, type Lifecycle, sampleEmpty } from "./empty.js";
import { runningEngine } from "./engine.js";
import { keep, samplePerCall } from "./per-call.js";
import {
  sampleSharedContext,
  type SamplerResult,
  type Sampling,
  type TimedMinimums,
} from "./shared-context.js";
import { NS_PER_MS, type Statistics, summarize } from "./statistics.js";
import { performanceNow, timerStepMs } from "./timer.js";

/** The run fails when the body's mean per call is below this multiple of the empty body's. */
const MIN_EMPTY_RATIO = 1.42;

/** `detail.kind` of a Node `gc` performance entry for a scavenge (`NODE_PERFORMANCE_GC_MINOR`). */
const GC_MINOR = 1;

/** `detail.kind` of a Node `gc` performance entry for a full mark-compact (`NODE_PERFORMANCE_GC_MAJOR`). */
const GC_MAJOR = 4;

/** The time, in milliseconds, the body's timed samples span at least when `time` is absent. */
const DEFAULT_TIME_MS = 1000;

/** The fewest timed samples the body runs when `samples` is absent. */
const DEFAULT_SAMPLES = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Keeps the engine from inlining `fn` into its callers, as Bun's `bun:jsc` `noInline` does. */
export type NoInline = typeof import("bun:jsc").noInline;

/**
 * A benchmark: how to build its context, the body to time, and how to release the context.
 *
 * A `sharedContext` benchmark builds one context and times every body call on it; a `perCall` one
 * builds a fresh context for every body call. The body must be synchronous.
 */
export interface Case<Context> {
  readonly kind: Lifecycle;
  readonly setup: () => Context;
  readonly fn: (context: Context) => unknown;
  /** Releases a context; absent means nothing to release. */
  readonly teardown?: (context: Context) => void;
}

export interface MeasureOptions {
  /** Calls per sample to run instead of calibrating one, for the empty body and the body alike. */
  readonly callsPerSample?: number;
  /** Replaces the engine's `noInline`: `bun:jsc`'s under Bun, none on Node. */
  readonly noInline?: NoInline;
  /** The clock, in milliseconds; defaults to `performance.now()`. */
  readonly now?: () => number;
  /**
   * The time, in milliseconds, the body's timed samples span at least; defaults to 1000. Not
   * validated: the caller passes a finite number of 0 or more.
   */
  readonly time?: number;
  /**
   * The fewest timed samples the body runs; defaults to 64. Not validated: the caller passes an
   * integer of 1 or more.
   */
  readonly samples?: number;
}

/** The collections a `gc` performance observer saw while the body's samples were timed. */
export interface GcDuringTiming {
  readonly count: number;
  readonly minor: number;
  readonly major: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface Measurement extends Statistics {
  readonly timerStepNs: number;
  readonly callsPerSample: number;
  /** Whether `callsPerSample` was given rather than calibrated by warmup. */
  readonly countFixed: boolean;
  /** Whether a collection ran between warmup and timing. */
  readonly collected: boolean;
  /** The body's mean per call divided by the empty body's. */
  readonly emptyRatio: number;
  /** Present only where the engine delivers `gc` performance entries, as Node does. */
  readonly gcDuringTiming?: GcDuringTiming;
  /** How many timing runs the body's sampler took, the kept one included. */
  readonly timingRuns: number;
  /** The body's samples before its kept run: warmup's, plus every discarded timing run's. */
  readonly warmupSamples: number;
  /** The body's kept timing run's length on the clock, in milliseconds. */
  readonly timingMs: number;
}

/** What the body's sampler is handed: the empty run's sampling plus `time` and `samples`. */
type BodySampling = Sampling & TimedMinimums;

/** A case whose absent teardown was replaced by one that releases nothing. */
interface Released<Context> extends Case<Context> {
  readonly teardown: (context: Context) => void;
}

/** The real-time bounds, on the `performance.now()` timeline, of the body's timed samples. */
interface TimingWindow {
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Measures a benchmark: the body, then an empty body in the benchmark's own lifecycle.
 *
 * Nothing samples or collects before the body's run. On Node, another function run through the
 * sampling loops, or a collection before the body's setup, changes how the engine compiles the
 * body: some bodies read up to 78 % slow.
 *
 * @param benchmark - The benchmark to measure.
 * @param options - A fixed count, an injected `noInline`, a clock to read, and the `time` and
 *   `samples` the body's timing runs until, 1000 ms and 64 when absent; the empty body always
 *   takes 64 timed samples.
 * @returns The body's per-call statistics in nanoseconds and how they were taken.
 * @throws Error when no garbage collector is exposed, before anything runs.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded, before anything runs.
 * @throws Error when the body's first call returns a thenable, after its context is torn down.
 * @throws Whatever `setup`, `fn` or `teardown` throws, unchanged, after every context left alive
 *   is torn down; a teardown error during that cleanup is discarded.
 * @throws Error when warmup's or a grown count would pass the cap: the body's or the empty run's
 *   warmup count, or a count grown after a discarded body run.
 * @throws Error when a sharedContext body's third timing run is discarded too, naming the count a
 *   fourth would need.
 * @throws Error when the body's mean per call is below 1.42 times the empty body's, naming both.
 */
export async function measure<Context>(
  benchmark: Case<Context>,
  options: MeasureOptions = {},
): Promise<Measurement> {
  const gc = globalThis.gc;
  if (typeof gc !== "function") {
    throw new Error("measuring requires an exposed gc: run node or bun with --expose-gc");
  }
  const noInline = options.noInline ?? (await engineNoInline());
  noInline?.(benchmark.fn);
  noInline?.(empty);

  const now = options.now ?? performanceNow;
  const stepMs = timerStepMs(now);
  const timing: TimingWindow = { startMs: 0, endMs: 0 };
  const sampling: Sampling = {
    now,
    stepMs,
    callsPerSample: options.callsPerSample,
    collect: () => {
      gc();
      timing.startMs = performance.now();
    },
  };

  const bodySampling: BodySampling = { ...sampling, ...timedMinimums(options) };

  const released: Released<Context> = { ...benchmark, teardown: benchmark.teardown ?? keep };
  const observer = observeCollections();
  let run: SamplerResult;
  let gcDuringTiming: GcDuringTiming | undefined;
  try {
    run =
      benchmark.kind === "sharedContext"
        ? measureSharedContext(released, bodySampling, timing)
        : measurePerCall(released, bodySampling, timing);
    if (observer !== undefined) {
      gcDuringTiming = await observer.during(timing);
    }
  } finally {
    observer?.disconnect();
  }

  const statistics = summarize(run.spans, run.samples, run.callsPerSample);
  // The body's timing window has closed, so the empty run's collection only collects.
  const emptyRatio = checkedEmptyRatio(statistics.mean, benchmark.kind, {
    ...sampling,
    collect: () => {
      gc();
    },
  });
  return {
    ...statistics,
    timerStepNs: stepMs * NS_PER_MS,
    callsPerSample: run.callsPerSample,
    countFixed: options.callsPerSample !== undefined,
    collected: true,
    emptyRatio,
    ...(gcDuringTiming === undefined ? {} : { gcDuringTiming }),
    timingRuns: run.timingRuns,
    warmupSamples: run.warmupSamples,
    timingMs: run.timingMs,
  };
}

/**
 * The `time` and `samples` the body's timing runs until.
 *
 * @param options - The options `measure` was given.
 * @returns The given `time` and `samples`, 1000 ms and 64 when absent.
 */
function timedMinimums(options: MeasureOptions): TimedMinimums {
  return { time: options.time ?? DEFAULT_TIME_MS, samples: options.samples ?? DEFAULT_SAMPLES };
}

/**
 * Times the empty body in the benchmark's own lifecycle and divides the body's mean by its mean.
 *
 * @param bodyMeanNs - The body's mean per call, in nanoseconds.
 * @param kind - The benchmark's lifecycle.
 * @param sampling - The clock, its step, the collection, and the fixed count if one was given.
 * @returns The body's mean per call divided by the empty body's.
 * @throws Error when the empty run's warmup count would pass its cap.
 * @throws Error when the ratio is below 1.42, naming both means.
 */
function checkedEmptyRatio(bodyMeanNs: number, kind: Lifecycle, sampling: Sampling): number {
  const emptyRun = sampleEmpty({ kind, ...sampling });
  const emptyMeanNs = summarize(emptyRun.spans, emptyRun.samples, emptyRun.callsPerSample).mean;
  const ratio = bodyMeanNs / emptyMeanNs;
  if (!(ratio >= MIN_EMPTY_RATIO)) {
    throw new Error(
      `the body reads ${formatNs(bodyMeanNs)} ns per call, under ${String(MIN_EMPTY_RATIO)} times the empty body's ${formatNs(emptyMeanNs)} ns: the benchmark times too little work to tell apart from the loop`,
    );
  }
  return ratio;
}

/**
 * Loads the running engine's `noInline`, importing `bun:jsc` only under Bun.
 *
 * @returns Bun's `noInline`, or `undefined` on any other engine.
 * @throws Error when Bun is running but `bun:jsc` cannot be loaded.
 */
async function engineNoInline(): Promise<NoInline | undefined> {
  if (runningEngine() !== "bun") return undefined;
  const { noInline } = await import("bun:jsc");
  return noInline;
}

// ---------------------------------------------------------------------------
// Lifecycle runners
// ---------------------------------------------------------------------------

/**
 * Runs a shared-context benchmark: builds one context, checks the body is synchronous, samples it,
 * then tears the context down.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its step, the collection, the fixed count if one was given, and the
 *   `time` and `samples` timing runs until.
 * @param timing - Receives the end of each timing run's samples, before the sampler checks the run;
 *   the collection before each run records their start.
 * @returns What the body's sampler returned.
 * @throws Whatever `setup` throws, before anything else runs.
 * @throws Error when the body's first call returns a thenable, after teardown ran.
 * @throws Whatever the body or the sampler throws, unchanged, after teardown ran; a teardown error
 *   then is discarded.
 * @throws Whatever `teardown` throws when the body succeeded.
 */
function measureSharedContext<Context>(
  benchmark: Released<Context>,
  sampling: BodySampling,
  timing: TimingWindow,
): SamplerResult {
  const { setup, fn, teardown } = benchmark;
  const context = setup();
  let run: SamplerResult;
  try {
    requireSynchronous(fn(context));
    run = sampleSharedContext({
      ...sampling,
      fn,
      context,
      afterTiming: () => {
        timing.endMs = performance.now();
      },
    });
  } catch (error) {
    tearDownDiscarding(teardown, context);
    throw error;
  }
  teardown(context);
  return run;
}

/**
 * Runs a per-call benchmark: checks the body is synchronous on one built context, then samples it,
 * tearing down every context left alive when anything throws.
 *
 * @param benchmark - The benchmark.
 * @param sampling - The clock, its step, the collection, the fixed count if one was given, and the
 *   `time` and `samples` timing runs until.
 * @param timing - Receives the end of the timed samples; the collection records their start.
 * @returns What the body's sampler returned.
 * @throws Error when the body's first call returns a thenable, after its context is torn down.
 * @throws Whatever `setup`, `fn`, `teardown` or the sampler throws, unchanged, after every context
 *   built and not torn down is torn down; a teardown error during that cleanup is discarded.
 */
function measurePerCall<Context>(
  benchmark: Released<Context>,
  sampling: BodySampling,
  timing: TimingWindow,
): SamplerResult {
  const { setup, fn, teardown } = benchmark;
  const slots: (Context | undefined)[] = [];
  try {
    const checked = setup();
    slots[0] = checked;
    requireSynchronous(fn(checked));
    teardown(checked);
    slots[0] = undefined;
    const run = samplePerCall({ ...sampling, setup, fn, teardown, slots });
    timing.endMs = performance.now();
    return run;
  } catch (error) {
    for (const context of slots) {
      if (context !== undefined) tearDownDiscarding(teardown, context);
    }
    throw error;
  }
}

/**
 * Fails a body whose call returned a thenable: the samplers time calls, not settled promises.
 *
 * @param returned - What the body's first call returned.
 * @throws Error when `returned` has a callable `then`.
 */
function requireSynchronous(returned: unknown): void {
  if (
    (typeof returned === "object" || typeof returned === "function") &&
    returned !== null &&
    typeof Reflect.get(returned, "then") === "function"
  ) {
    throw new Error("benchmark bodies must be synchronous: the body returned a thenable");
  }
}

/**
 * Tears `context` down while an error is already in flight: that error wins, so the teardown's
 * own error is dropped rather than replacing it, which a `finally` would do.
 *
 * @param teardown - The benchmark's teardown.
 * @param context - The context to release.
 */
function tearDownDiscarding<Context>(teardown: (context: Context) => void, context: Context): void {
  try {
    teardown(context);
  } catch {
    // The error already propagating is the one the caller sees.
  }
}

// ---------------------------------------------------------------------------
// GC observation
// ---------------------------------------------------------------------------

/** A `gc` performance observer for the body's run. */
interface CollectionObserver {
  readonly during: (timing: TimingWindow) => Promise<GcDuringTiming>;
  readonly disconnect: () => void;
}

/**
 * Starts observing `gc` performance entries, where the engine delivers them.
 *
 * @returns The observer, or `undefined` where the engine has no `gc` entry type, as on Bun or in a
 *   browser.
 */
function observeCollections(): CollectionObserver | undefined {
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("gc")
  ) {
    return undefined;
  }
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    entries.push(...list.getEntries());
  });
  observer.observe({ entryTypes: ["gc"] });
  return {
    during: async (timing) => {
      // Node queues a gc entry from a native setImmediate callback and dispatches it to observers
      // after that: two timer turns guarantee the loop has passed its check phase between them.
      await nextTurn();
      await nextTurn();
      entries.push(...observer.takeRecords());
      return summarizeCollections(
        entries.filter(
          (entry) => entry.startTime >= timing.startMs && entry.startTime < timing.endMs,
        ),
      );
    },
    disconnect: () => {
      observer.disconnect();
    },
  };
}

/**
 * Waits for a later turn of the event loop.
 *
 * @returns A promise that resolves on that turn.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Counts collections by kind and sums their durations.
 *
 * @param entries - The `gc` performance entries to count.
 * @returns How many there were, how many were minor and major, and their total and longest
 *   duration in milliseconds.
 */
function summarizeCollections(entries: readonly PerformanceEntry[]): GcDuringTiming {
  let minor = 0;
  let major = 0;
  let totalMs = 0;
  let maxMs = 0;
  for (const entry of entries) {
    const kind = gcKind(entry);
    if (kind === GC_MINOR) minor += 1;
    if (kind === GC_MAJOR) major += 1;
    totalMs += entry.duration;
    maxMs = Math.max(maxMs, entry.duration);
  }
  return { count: entries.length, minor, major, totalMs, maxMs };
}

/**
 * Reads the collection kind Node records in a `gc` entry's `detail`.
 *
 * @param entry - A `gc` performance entry.
 * @returns The entry's `detail.kind`, or `undefined` when it carries none.
 */
function gcKind(entry: PerformanceEntry): unknown {
  const detail: unknown = Reflect.get(entry, "detail");
  return typeof detail === "object" && detail !== null ? Reflect.get(detail, "kind") : undefined;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a per-call time for an error message, to at most three decimals.
 *
 * @param ns - The time, in nanoseconds.
 * @returns The time as a plain decimal.
 */
function formatNs(ns: number): string {
  return String(Number(ns.toFixed(3)));
}
