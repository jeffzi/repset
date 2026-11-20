/**
 * Generic helpers: code that names no project type and would make sense in any repository.
 *
 * The `measure` modules import it and load in a browser page, so it reads no Node builtin.
 */

const TRANSITIONS_PER_PASS = 2000;

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
    case "bigint":
      return `${value}n`;
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
 * Reads the message of a thrown value, without letting a read or a conversion throw in place of the
 * failure it describes.
 *
 * @param value - The thrown value.
 * @returns The string form of the value's `message` when it is an `Error`, so a `message` that is
 *   not a string still reads as one; otherwise `String(value)`. Either is
 *   `"a value with no string form"` when it throws, as the conversion does for a null-prototype
 *   object, the read does for a `message` getter that throws, and the `Error` check does for a
 *   Proxy whose `getPrototypeOf` trap throws.
 */
export function thrownMessage(value: unknown): string {
  try {
    if (!(value instanceof Error)) return String(value);
    const message: unknown = value.message;
    return String(message);
  } catch {
    return "a value with no string form";
  }
}

/**
 * Reads the stack of a thrown value without letting the check or the read throw.
 *
 * @param value - The thrown value.
 * @returns The stack when `value` is an `Error` with a string stack; `null` when it is not, or when
 *   the check or the read throws.
 */
export function errorStack(value: unknown): string | null {
  try {
    return value instanceof Error && typeof value.stack === "string" ? value.stack : null;
  } catch {
    return null;
  }
}

/**
 * Whether `value` is an instance of `type`, without letting the check throw.
 *
 * @param value - The value to check.
 * @param type - The constructor to check against.
 * @returns `value instanceof type`, or `false` when the check throws, as a Proxy's `getPrototypeOf`
 *   trap can.
 */
export function isInstance<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

/**
 * Reads the value at `index`, refusing an index that holds none.
 *
 * @param values - The values to read from.
 * @param index - The zero-based index to read.
 * @returns The value at `index`.
 * @throws RangeError when no value is at `index`, as when it is outside the values.
 */
export function valueAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`no value at index ${index}: ${values.length} values`);
  }
  return value;
}

/** Splits text into the characters a person sees. */
export const GRAPHEMES = new Intl.Segmenter();

/** How many distinct pairs `size` items form. */
export function pairsOf(size: number): number {
  return (size * (size - 1)) / 2;
}

/**
 * Reads quantile `q` of ascending values, linearly interpolated between the two nearest ranks.
 *
 * @param sorted - The values, ascending.
 * @param q - The quantile, from 0 to 1.
 * @returns The interpolated value.
 * @throws RangeError when `sorted` is empty.
 */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const position = (sorted.length - 1) * q;
  const lowerRank = Math.floor(position);
  const lowValue = valueAt(sorted, lowerRank);
  const highValue = valueAt(sorted, Math.ceil(position));
  return lowValue + (highValue - lowValue) * (position - lowerRank);
}
