/**
 * Observes the `gc` performance entries a runtime delivers while the body's samples are timed, and
 * counts them by kind.
 */

import { property } from "../utils.js";

/**
 * `detail.kind` values of a Node `gc` performance entry for a young-generation collection: a
 * scavenge (`NODE_PERFORMANCE_GC_MINOR`) and V8's minor mark-sweep.
 */
const GC_MINOR_KINDS: ReadonlySet<unknown> = new Set([1, 2]);

/** `detail.kind` of a Node `gc` performance entry for a full mark-compact (`NODE_PERFORMANCE_GC_MAJOR`). */
const GC_MAJOR = 4;

/**
 * The collections a `gc` performance observer saw while the body's samples were timed.
 *
 * Only minor and major collections count: incremental-marking steps and weak-callback processing
 * are parts of a collection, not collections of their own.
 */
export interface GcDuringTiming {
  readonly collectionCount: number;
  readonly durationMs: number;
  readonly maxDurationMs: number;
  readonly nodeMinorCollectionCount: number;
  readonly nodeMajorCollectionCount: number;
}

/** The real-time bounds, on the `performance.now()` timeline, of the body's timed samples. */
export interface TimingWindow {
  startMs: number;
  endMs: number;
}

interface CollectionObserver {
  readonly during: (timing: TimingWindow) => Promise<GcDuringTiming>;
  readonly disconnect: () => void;
}

/**
 * Starts observing `gc` performance entries, where the runtime delivers them.
 *
 * @returns The observer, or `undefined` where the runtime has no `gc` entry type, as on Bun or in a
 *   browser.
 */
export function observeCollections(): CollectionObserver | undefined {
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

/** Resolves after one `setTimeout(0)` turn of the event loop, so pending native callbacks have run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Counts the minor and major collections and sums their durations.
 *
 * @param entries - The `gc` performance entries to count.
 * @returns How many minor and major collections there were, how many of each, and their total and
 *   longest duration in milliseconds.
 */
function summarizeCollections(entries: readonly PerformanceEntry[]): GcDuringTiming {
  let minor = 0;
  let major = 0;
  let durationMs = 0;
  let maxDurationMs = 0;
  for (const entry of entries) {
    const kind = property(property(entry, "detail"), "kind");
    if (GC_MINOR_KINDS.has(kind)) minor += 1;
    else if (kind === GC_MAJOR) major += 1;
    else continue;
    durationMs += entry.duration;
    maxDurationMs = Math.max(maxDurationMs, entry.duration);
  }
  return {
    collectionCount: minor + major,
    durationMs,
    maxDurationMs,
    nodeMinorCollectionCount: minor,
    nodeMajorCollectionCount: major,
  };
}
