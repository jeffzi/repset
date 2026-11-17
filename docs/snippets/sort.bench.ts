import { bench } from "repset";

const SIZE = 1000;
// Prime, so the stride visits every value once.
const STRIDE = 7919;
const shuffled = Array.from({ length: SIZE }, (_, index) => (index * STRIDE) % SIZE);

bench("sort/copy", () => shuffled.toSorted((a, b) => a - b));
