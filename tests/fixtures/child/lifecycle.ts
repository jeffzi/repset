import { bench } from "../../../src/bench.js";

const CALLS = Symbol.for("repset.child-calls");

/** Appends `entry` to the call list a test installed on `globalThis`, if any. */
function record(entry: unknown): void {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (Array.isArray(calls)) calls.push(entry);
}

/** A case whose every callback records its call under `name`. */
function recorded(name: string, setupPerCall: boolean): void {
  bench(name, {
    setup: () => {
      record(`${name} setup`);
      return { name };
    },
    fn: (state) => {
      record(`${state.name} fn`);
    },
    teardown: (state) => {
      record(`${state.name} teardown`);
    },
    setupPerCall,
  });
}

recorded("quiet", false);
recorded("batch", true);
recorded("other", false);

bench("steady", {
  setup: () => Array.from({ length: 512 }, (_, index) => index),
  fn: (values) => {
    let total = 0;
    for (const value of values) total += value;
    return total;
  },
});

bench("setup-throws", {
  setup: () => {
    throw new Error("fig");
  },
  fn: () => 1,
  teardown: () => {
    record("setup-throws teardown");
  },
});

bench("fn-throws", {
  setup: () => 0,
  fn: () => {
    const error = new Error("kiwi");
    record(error);
    throw error;
  },
  teardown: () => {
    record("fn-throws teardown");
  },
});

bench("fn-returns-thenable", {
  setup: () => 0,
  // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
  fn: () => ({ then: () => 0 }),
  teardown: () => {
    record("fn-returns-thenable teardown");
  },
});

bench("fn-and-teardown-throw", {
  setup: () => 0,
  fn: () => {
    throw new Error("lime");
  },
  teardown: () => {
    throw new Error("melon");
  },
});

bench("teardown-throws", {
  setup: () => 0,
  fn: () => 1,
  teardown: () => {
    throw new Error("pear");
  },
});
