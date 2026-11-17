import { bench } from "../../../src/child.js";

bench("throws/always", () => {
  throw new Error("banana");
});
