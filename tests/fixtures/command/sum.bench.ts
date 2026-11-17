import { bench } from "../../../src/child.js";

const VALUES = [3, 1, 2];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

bench("sum/small", () => sum(VALUES));
bench("sum/large", () => sum([...VALUES, ...VALUES]));
