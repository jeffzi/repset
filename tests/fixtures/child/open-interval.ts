import { bench } from "../../../src/bench.js";

// A handle left open that would keep the process alive on its own.
setInterval(() => 0, 1000);

bench("orange", () => 1);
