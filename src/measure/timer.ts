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
 * more than one resolution; the resolution is the smallest change across the second pass. Blocks until the
 * clock has advanced through both passes, so a clock that never changes never returns.
 *
 * @param now - The clock to probe, in milliseconds. Defaults to {@link performanceNow}.
 * @returns The clock's resolution in milliseconds.
 */
export function timerResolutionMs(now: () => number = performanceNow): number {
  smallestChange(now, TRANSITIONS_PER_PASS);
  return smallestChange(now, TRANSITIONS_PER_PASS);
}
