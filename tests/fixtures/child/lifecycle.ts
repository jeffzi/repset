import { bench } from "../../../src/bench.js";

const CALLS = Symbol.for("repset.child-calls");

/** Appends `entry` to the call list a test installed on `globalThis`, if any. */
function record(entry: unknown): void {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (Array.isArray(calls)) calls.push(entry);
}

/** Counts the entries ending in `suffix` that the call list holds, 0 when none is installed. */
function recorded(suffix: string): number {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (!Array.isArray(calls)) return 0;
  return calls.filter((entry) => typeof entry === "string" && entry.endsWith(suffix)).length;
}

/** A case whose every callback records its call under `name`, building a state per call when asked. */
function benchRecorded(name: string, setupPerCall = false): void {
  bench(name, {
    setupPerCall,
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

benchRecorded("quiet");
benchRecorded("other");
benchRecorded("quiet-per-call", true);

bench("third-fn-throws-per-call", {
  setup: () => {
    record("third setup");
    return 0;
  },
  fn: () => {
    record("third fn");
    if (recorded(" fn") >= 3) throw new Error("grape");
  },
  teardown: () => {
    record("third teardown");
  },
  setupPerCall: true,
});

bench("steady", {
  setup: () => Array.from({ length: 512 }, (_, index) => index),
  fn: (values) => {
    let total = 0;
    for (const value of values) total += value;
    return total;
  },
});

bench("fn-throws", {
  setup: () => 0,
  fn: () => {
    throw new Error("kiwi");
  },
});

bench("second-setup-throws-per-call", {
  setup: () => {
    record("second setup");
    if (recorded(" setup") >= 2) throw new Error("plum");
    return 0;
  },
  fn: () => 0,
  setupPerCall: true,
});

bench("teardown-throws-per-call", {
  setup: () => 0,
  fn: (state) => state + 1,
  teardown: () => {
    throw new Error("pear");
  },
  setupPerCall: true,
});

bench("fn-and-teardown-throw-per-call", {
  setup: () => 0,
  fn: () => {
    throw new Error("lemon");
  },
  teardown: () => {
    throw new Error("mango");
  },
  setupPerCall: true,
});

bench("async-setup-per-call", {
  setupPerCall: true,
  setup: () => Promise.resolve(0),
  fn: () => undefined,
});

bench("async-fn-per-call", {
  setupPerCall: true,
  setup: () => 0,
  fn: () => Promise.resolve(),
});
