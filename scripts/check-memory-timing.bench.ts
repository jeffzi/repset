// The memory timing check's bodies, each timed with memory measured and without.
//
// `each` and `inlined` are the timing accuracy check's shared-state bodies. `allocating` allocates
// one object per call and keeps the latest on its shared state. `setup-per-call` sorts a fresh
// array that `setup` builds before each call, so its timing depends on per-call state as
// `setupPerCall` cases do. `bench` comes from the built entry, so the measuring child loads one
// copy of repset, the built one, as a user's child does.
import { bench } from "../dist/index.js";
import { memoryBenchName } from "./check-memory-timing-bodies.js";
import { BODIES, BODY_NAMES, buildState } from "./check-timing-accuracy/bodies.js";

/**
 * The allocating body's state: a counter, so no call's object is a constant, and the last object.
 */
interface Holder {
  calls: number;
  latest: { readonly a: number; readonly b: number } | undefined;
}

const SORTED_SIZE = 64;

/**
 * Scatters the sorted body's values: a prime stride modulo a smaller prime, so no run is sorted.
 */
const SCATTER_STRIDE = 7919;

const SCATTER_MODULUS = 101;

for (const name of BODY_NAMES) {
  bench(memoryBenchName(name), { setup: buildState, fn: BODIES[name] });
}

bench(memoryBenchName("allocating"), {
  setup: (): Holder => ({ calls: 0, latest: undefined }),
  fn: (holder) => {
    holder.calls += 1;
    holder.latest = { a: holder.calls, b: holder.calls * 2 };
  },
});

bench(memoryBenchName("setup-per-call"), {
  setupPerCall: true,
  setup: (): number[] =>
    Array.from({ length: SORTED_SIZE }, (_, index) => (index * SCATTER_STRIDE) % SCATTER_MODULUS),
  fn: (values) => {
    values.sort((left, right) => left - right);
  },
});
