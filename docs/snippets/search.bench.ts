import { bench } from "repset";

// fallow-ignore-next-line code-duplication -- the README shows a self-contained file
function binarySearch(values: readonly number[], target: number): number {
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

bench("search/binary", {
  setup: () => Array.from({ length: 10_000 }, (_, index) => index * 2),
  fn: (values) => binarySearch(values, 4242),
});
