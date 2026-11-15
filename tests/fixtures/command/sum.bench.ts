import { bench } from "../../../src/bench.js";

const VALUES = [3, 1, 2];

bench("sum/small", () => VALUES.reduce((total, value) => total + value, 0));
bench("sum/large", () => [...VALUES, ...VALUES].reduce((total, value) => total + value, 0));
