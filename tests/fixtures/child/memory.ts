import { bench } from "../../../src/bench.js";

/** Numbers each body sums, so every body costs well above an empty body while allocating nothing. */
const VALUES: readonly number[] = Array.from({ length: 256 }, (_, index) => index);

/** Where a `setupPerCall` body keeps its sum, a small integer, since repset discards its return. */
let numberSink = 0;

/** Where a body keeps the object it built, so the engine cannot drop the allocation. */
export let objectSink: object = {};

/** The sum of `values`, read with an indexed loop that allocates no iterator. */
function sum(values: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < values.length; index++) total += values[index] ?? 0;
  return total;
}

bench("zero", () => sum(VALUES));

// A two-field object of small integers is 40 bytes on Node's 64-bit heap.
bench("object", () => {
  objectSink = { a: sum(VALUES), b: 1 };
  return objectSink;
});

bench("zero-per-call", {
  setup: () => VALUES,
  fn: (values) => {
    numberSink = (numberSink + sum(values)) & 0x3fffffff;
  },
  setupPerCall: true,
});

bench("object-per-call", {
  setup: () => VALUES,
  fn: (values) => {
    objectSink = { a: sum(values), b: 1 };
  },
  setupPerCall: true,
});
