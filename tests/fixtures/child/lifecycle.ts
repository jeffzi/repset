import { bench } from "../../../src/bench.js";

const CALLS = Symbol.for("repset.child-calls");

/** Appends `entry` to the call list a test installed on `globalThis`, if any. */
function record(entry: unknown): void {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (Array.isArray(calls)) calls.push(entry);
}

/** A teardown that records its call under `name`. */
function recordTeardown(name: string): () => void {
  return () => {
    record(`${name} teardown`);
  };
}

/** A case whose every callback records its call under `name`. */
function recorded(name: string): void {
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
  });
}

recorded("quiet");
recorded("other");

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
  teardown: recordTeardown("setup-throws"),
});

bench("fn-throws", {
  setup: () => 0,
  fn: () => {
    const error = new Error("kiwi");
    record(error);
    throw error;
  },
  teardown: recordTeardown("fn-throws"),
});

bench("fn-returns-thenable", {
  setup: () => 0,
  // oxlint-disable-next-line unicorn/no-thenable -- a thenable body result is the input under test
  fn: () => ({ then: () => 0 }),
  teardown: recordTeardown("fn-returns-thenable"),
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
