import { bench } from "../../../src/bench.js";

bench("throws/always", () => {
  throw new Error("banana");
});
