import { bench } from "repset";

const input = Array.from({ length: 1000 }, (_, index) => (index * 7919) % 1000);

bench("sort/copy", () => input.toSorted((a, b) => a - b));
