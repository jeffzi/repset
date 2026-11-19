import { bench } from "../../../src/bench.js";

const CALLS = Symbol.for("repset.child-calls");

/** Appends `entry` to the call list a test installed on `globalThis`, once, if there is one. */
function recordOnce(entry: string): void {
  const calls: unknown = Reflect.get(globalThis, CALLS);
  if (Array.isArray(calls) && !calls.includes(entry)) calls.push(entry);
}

bench("plain", () => 1);

bench("sort", {
  fn: {
    quick: () => {
      recordOnce("quick fn");
    },
    merge: () => {
      recordOnce("merge fn");
    },
  },
});
