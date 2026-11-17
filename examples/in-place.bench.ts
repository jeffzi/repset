// Scenario: time a function that changes its input.
//
// An in-place sort leaves its input sorted, so from its second call on it would time sorting a
// sorted array. `setupPerCall: true` runs `setup` before every call, off the clock, and each call
// sorts a fresh shuffled array.
import { bench } from "repset";

const LENGTH = 500;

/** The same shuffled numbers on every call, so every call does the same work. */
function shuffled(): number[] {
  return Array.from({ length: LENGTH }, (_, index) => (index * 7919) % LENGTH);
}

bench("sort-in-place/array", {
  setup: shuffled,
  // oxlint-disable-next-line unicorn/no-array-sort -- the in-place sort is what this case times
  fn: (values) => values.sort((a, b) => a - b),
  setupPerCall: true,
});

// A typed array sorts its numbers by value, with no comparator to call.
bench("sort-in-place/float64-array", {
  setup: () => Float64Array.from(shuffled()),
  // oxlint-disable-next-line unicorn/no-array-sort -- the in-place sort is what this case times
  fn: (values) => values.sort(),
  setupPerCall: true,
});
