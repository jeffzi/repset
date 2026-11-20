// The A/A contest, copied from the research prototype for a run on a GitHub-hosted runner: each
// benchmark's two contenders are one function body copied byte for byte, so any verdict between
// them is noise. Three body sizes, about 50 ns, 1 µs and 100 µs per call.
// The copies are the measurement: one shared function would not test two placements in one file.
// fallow-ignore-file code-duplication
import { bench } from "repset";

/** Values in [1, 2), the same in every process. */
function inputOf(length: number): Float64Array {
  return Float64Array.from({ length }, (_, index) => 1 + ((index * 7919) % 1000) / 1000);
}

const TINY = 16;
const MEDIUM = 200;
const LARGE = 20_000;

bench("aa-50ns", {
  setup: () => inputOf(TINY),
  fn: {
    a: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
    b: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
  },
});

bench("aa-1us", {
  setup: () => inputOf(MEDIUM),
  fn: {
    a: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
    b: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
  },
});

bench("aa-100us", {
  setup: () => inputOf(LARGE),
  fn: {
    a: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
    b: (values) => {
      let sum = 0;
      for (const value of values) sum += Math.sqrt(value);
      return sum;
    },
  },
});
