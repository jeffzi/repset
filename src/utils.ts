/**
 * Generic helpers: code that names no project type and would make sense in any repository.
 *
 * The `measure` modules import it and load in a browser page, so it reads no Node builtin.
 */

/** Like `Omit`, but `K` must be a key of `T`, so a misspelled or removed key fails to compile. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

const TRANSITIONS_PER_PASS = 2000;

/**
 * The default clock.
 *
 * Called on `performance`, since an unbound `now` throws on Node.
 *
 * @returns The current high-resolution time, in milliseconds.
 */
export function performanceNow(): number {
  return performance.now();
}

/**
 * Reads `now` until it has seen {@link TRANSITIONS_PER_PASS} transitions, reads that differ from
 * the previous one, and measures the smallest change between them.
 *
 * @param now - The clock to read, in milliseconds.
 * @returns The smallest change across the measured transitions, in milliseconds.
 */
function smallestChange(now: () => number): number {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = now();
  let seen = 0;
  while (seen < TRANSITIONS_PER_PASS) {
    const current = now();
    if (current !== previous) {
      smallest = Math.min(smallest, current - previous);
      previous = current;
      seen += 1;
    }
  }
  return smallest;
}

/**
 * Probes the resolution of a clock: the smallest change between two successive distinct reads.
 *
 * A first pass of transitions warms the loop and is discarded, since its early transitions span
 * more than one resolution; the resolution is the smallest change across the second pass. Blocks
 * until the clock has advanced through both passes, so a clock that never changes never returns.
 *
 * @param now - The clock to probe, in milliseconds.
 * @returns The clock's resolution in milliseconds.
 */
export function timerResolutionMs(now: () => number): number {
  smallestChange(now);
  return smallestChange(now);
}

/** Names `value` in an error message without printing a function's source or an object's body. */
export function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "object":
      return value === null ? "null" : "an object";
    case "function":
      return "a function";
    case "string":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Reads one property of a value, for a value that may not be an object.
 *
 * @param value - The value to read from.
 * @param key - The property to read.
 * @returns The property's value when `value` is a non-null object, `undefined` otherwise.
 */
export function property(value: unknown, key: PropertyKey): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Whether `value` is a non-null, non-array object, narrowed to read its fields as `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the message of a thrown value, without letting a conversion throw in place of the failure
 * it describes.
 *
 * @param value - The thrown value.
 * @returns The value's own `message` when it is an `Error`; otherwise `String(value)`, or
 *   `"a value with no string form"` when that conversion throws, as it does for a null-prototype
 *   object.
 */
export function thrownMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return String(value);
  } catch {
    return "a value with no string form";
  }
}
