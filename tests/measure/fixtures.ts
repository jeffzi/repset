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
export function exposedGc(options?: NodeJS.GCOptions & { execution?: "sync" }): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 exposed no gc function");
  const args = options === undefined ? [] : [options];
  return () => {
    Reflect.apply(gc, undefined, args);
  };
}

/**
 * Returns the Error a synchronous call throws, failing the test when it throws nothing, a non-Error,
 * or returns a promise.
 *
 * @param call - The synchronous call expected to throw.
 * @returns The Error the call threw.
 * @throws {Error} When the call returns a promise, throws a non-Error, or throws nothing.
 */
export function errorOf(call: () => unknown): Error {
  let returned: unknown;
  try {
    returned = call();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("threw a non-Error value", { cause: error });
  }
  if (returned instanceof Promise) {
    returned.catch(() => undefined);
    throw new TypeError("errorOf takes a synchronous call");
  }
  throw new Error("did not throw");
}
