import { bench } from "repset";

const size = 1000;
const shuffled = Array.from({ length: size }, (_, index) => (index * 7919) % size);

bench("sort/copy", () => shuffled.toSorted((a, b) => a - b));
