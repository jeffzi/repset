import { bench } from "repset";

bench("sort/in-place", {
  setup: () => Array.from({ length: 1000 }, (_, index) => (index * 7919) % 1000),
  // oxlint-disable-next-line unicorn/no-array-sort -- the in-place sort is what this case times
  fn: (values) => values.sort((a, b) => a - b),
  setupPerCall: true,
});
