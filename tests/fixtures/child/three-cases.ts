import { bench } from "../../../src/child.js";

bench("alpha", () => 1);
bench("beta", { setup: () => [3, 1, 2], fn: (values) => values.length, setupPerCall: true });
bench("gamma", { setup: () => [3, 1, 2], fn: (values) => values.length, setupPerCall: false });
