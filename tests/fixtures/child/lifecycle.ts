import { bench } from "../../../src/child.js";
import { trappedProxy, unreadableStackError } from "../../thrown-values.js";

const CALLS = Symbol.for("repset.child-calls");

/** Appends `entry` to the call list a test installed on `globalThis`, if any. */
function record(entry: unknown): void {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (Array.isArray(calls)) calls.push(entry);
}

/** A case whose every callback records its call under `name`. */
function benchRecorded(name: string): void {
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

benchRecorded("quiet");
benchRecorded("other");

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

bench("fn-throws-string", {
  setup: () => 0,
  fn: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- a thrown value that is not an Error is the input under test
    throw "pear";
  },
});

bench("fn-throws-numeric-stack", {
  setup: () => 0,
  fn: () => {
    const error = new Error("plum");
    Object.defineProperty(error, "stack", { value: 42 });
    throw error;
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

bench("fn-throws-unreadable-stack", {
  setup: () => 0,
  fn: () => {
    throw unreadableStackError();
  },
});

bench("fn-throws-trapped-proxy", {
  setup: () => 0,
  fn: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- a thrown value whose instanceof check throws is the input under test
    throw trappedProxy();
  },
});
