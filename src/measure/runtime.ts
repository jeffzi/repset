export const RUNTIMES = ["node", "bun"] as const;

export type Runtime = (typeof RUNTIMES)[number];

/** The runtimes whose measuring child reads the heap; any other returns `memory: null`. */
export const HEAP_READING_RUNTIMES: readonly Runtime[] = ["node"];

/** Whether a measuring child on `runtime` reads the heap. */
export function hasHeapReading(runtime: Runtime): boolean {
  return HEAP_READING_RUNTIMES.includes(runtime);
}

/**
 * Names the runtime running this process, read from the `Bun` global Bun defines, so `measure`,
 * which loads in a browser page, needs no Node builtin to tell.
 *
 * @returns `"bun"` under Bun, `"node"` otherwise.
 */
export function runningRuntime(): Runtime {
  return "Bun" in globalThis ? "bun" : "node";
}
