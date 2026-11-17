import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/** A timer resolution fine enough that 100 ms samples span far more than 200 times the resolution. */
export const FINE_RESOLUTION = 2 ** -10;

/** A timer resolution coarse enough that short samples span few multiples of the resolution or none. */
export const COARSE_RESOLUTION = 2 ** -4;

/**
 * Exposes V8's garbage collector by enabling the `--expose-gc` flag for the whole process.
 *
 * @param options - Forwarded to every `gc` call, e.g. `{ type: "minor" }`. When omitted, `gc` is
 *   called with no argument, which runs a major collection.
 * @returns A function that runs a garbage collection when called.
 * @throws {Error} When V8 exposes no `gc` function after the flag is set.
 */
export function enabledGc(options?: NodeJS.GCOptions & { execution?: "sync" }): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 exposed no gc function");
  const args = options === undefined ? [] : [options];
  return () => {
    Reflect.apply(gc, undefined, args);
  };
}
