import { bench } from "repset";

const SIZE = 1000;
// Prime, so the stride visits every value once.
const STRIDE = 7919;

bench("sort/in-place", {
  setup: () => Array.from({ length: SIZE }, (_, index) => (index * STRIDE) % SIZE),
  // oxlint-disable-next-line unicorn/no-array-sort -- the in-place sort is what this case times
  fn: (values) => values.sort((a, b) => a - b),
  setupPerCall: true,
});
