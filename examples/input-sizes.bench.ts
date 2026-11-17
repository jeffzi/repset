// Scenario: see how each implementation scales with the size of its input.
//
// Register one benchmark per size in a loop, with the size as the last segment of the name. `setup`
// builds each input off the clock, once, and every call of `fn` reads it. A shared state fits here
// because a search leaves its input as it found it.
//
//   npx repset input-sizes.bench.ts --filter '/10000$'
import { bench } from "repset";

const SIZES = [100, 10_000];

interface SearchInput {
  readonly values: readonly number[];
  readonly target: number;
}

function sortedInput(size: number): SearchInput {
  const values = Array.from({ length: size }, (_, index) => index * 2);
  // Searching for a value near the end makes the linear search walk most of the array.
  const target = values.at(-2);
  if (target === undefined) {
    throw new RangeError(`a search input needs at least 2 values, got ${String(size)}`);
  }
  return { values, target };
}

function linearSearch({ values, target }: SearchInput): number {
  return values.indexOf(target);
}

function binarySearch({ values, target }: SearchInput): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle] ?? 0;
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

for (const size of SIZES) {
  bench(`search/linear/${String(size)}`, { setup: () => sortedInput(size), fn: linearSearch });
  bench(`search/binary/${String(size)}`, { setup: () => sortedInput(size), fn: binarySearch });
}
