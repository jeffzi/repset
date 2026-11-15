/**
 * Generic helpers: code that names no project type and would make sense in any repository.
 *
 * The `measure` modules import it and load in a browser page, so it reads no Node builtin.
 */

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
 * Reads `now` until it has seen a given number of transitions, reads that differ from the
 * previous one, and measures the smallest change between them.
 *
 * @param now - The clock to read, in milliseconds.
 * @param transitions - How many transitions to measure.
 * @returns The smallest change across the measured transitions, in milliseconds.
 */
function smallestChange(now: () => number, transitions: number): number {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = now();
  let seen = 0;
  while (seen < transitions) {
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
 * @param now - The clock to probe, in milliseconds. Defaults to {@link performanceNow}.
 * @returns The clock's resolution in milliseconds.
 */
export function timerResolutionMs(now: () => number = performanceNow): number {
  smallestChange(now, TRANSITIONS_PER_PASS);
  return smallestChange(now, TRANSITIONS_PER_PASS);
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
