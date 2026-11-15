import { bench } from "../../../src/bench.js";

await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
bench("late", () => 1);
