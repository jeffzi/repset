import { describe, expect, it, vi } from "vitest";

import { observeCollections } from "../../src/measure/collections.js";

interface Collection {
  readonly kind: number;
  readonly startTime: number;
  readonly duration: number;
}

/** The timing window every test reads, in milliseconds since the time origin. */
const WINDOW = { startMs: 100, endMs: 200 } as const;

/** A `gc` performance entry of `kind`, as Node delivers it. */
function gcEntry({ kind, startTime, duration }: Collection): object {
  return {
    name: "gc",
    entryType: "gc",
    startTime,
    duration,
    detail: { kind, flags: 0 },
    toJSON: () => ({}),
  };
}

/**
 * Stubs `PerformanceObserver` with one that supports `gc` entries and delivers its entries in a
 * microtask once observing starts.
 *
 * @param collections - The collections the stub delivers, one `gc` entry each.
 */
function deliversCollections(collections: readonly Collection[]): void {
  const entries = collections.map(gcEntry);
  const list = {
    getEntries: () => entries,
    getEntriesByType: (type: string) => (type === "gc" ? entries : []),
    getEntriesByName: (name: string) => (name === "gc" ? entries : []),
  };
  class DeliveringObserver {
    static readonly supportedEntryTypes: readonly string[] = ["gc"];
    readonly #callback: (delivered: typeof list, observer: DeliveringObserver) => void;

    constructor(callback: (delivered: typeof list, observer: DeliveringObserver) => void) {
      this.#callback = callback;
    }

    observe(): void {
      queueMicrotask(() => {
        this.#callback(list, this);
      });
    }

    disconnect(): void {
      // Nothing to stop: the entries were delivered once.
    }

    takeRecords(): readonly object[] {
      return [];
    }
  }
  vi.stubGlobal("PerformanceObserver", DeliveringObserver);
}

/** The collections the stubbed observer reports for {@link WINDOW}. */
async function collectionsInWindow(): Promise<unknown> {
  const observer = observeCollections();
  if (observer === undefined) throw new Error("no observer started");
  const gc = await observer.during(WINDOW);
  observer.disconnect();
  return gc;
}

describe("observeCollections", () => {
  describe("when collections start inside the timing window", () => {
    it("counts kinds 1 and 2 as minor and kind 4 as major, with their sum, total and longest duration", async () => {
      deliversCollections([
        { kind: 1, startTime: 110, duration: 0.5 },
        { kind: 2, startTime: 120, duration: 0.25 },
        { kind: 4, startTime: 130, duration: 2 },
      ]);

      const gc = await collectionsInWindow();

      expect(gc).toStrictEqual({
        collectionCount: 3,
        durationMs: 2.75,
        maxDurationMs: 2,
        nodeMinorCollectionCount: 2,
        nodeMajorCollectionCount: 1,
      });
    });

    it("counts incremental-marking and weak-callback entries in none of the five", async () => {
      deliversCollections([
        { kind: 8, startTime: 110, duration: 3 },
        { kind: 16, startTime: 120, duration: 4 },
        { kind: 1, startTime: 130, duration: 0.5 },
      ]);

      const gc = await collectionsInWindow();

      expect(gc).toStrictEqual({
        collectionCount: 1,
        durationMs: 0.5,
        maxDurationMs: 0.5,
        nodeMinorCollectionCount: 1,
        nodeMajorCollectionCount: 0,
      });
    });
  });
});
