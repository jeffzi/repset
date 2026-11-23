// The memory timing check's body names and the bench name each is registered under, shared by the
// bench file that registers them and the driver that filters on them, so the two cannot drift.
//
// The driver never imports `check-memory-timing.bench.ts` for these: importing it registers its
// cases with the built repset. `each` and `inlined` are the timing accuracy check's bodies.
import { BODY_NAMES } from "./check-timing-accuracy/bodies.js";

export const MEMORY_BODY_NAMES = [...BODY_NAMES, "allocating", "setup-per-call"] as const;

export type MemoryBodyName = (typeof MEMORY_BODY_NAMES)[number];

/**
 * The name the memory timing bench registers `body` under.
 *
 * @param body - The body the case times.
 * @returns The bench name, `check-memory-timing/` followed by the body's name.
 */
export function memoryBenchName(body: MemoryBodyName): string {
  return `check-memory-timing/${body}`;
}
