import { bench } from "../../../src/child.js";

const LINE_BYTES = 1024 * 1024 - 1;

// 2^20 bytes to each stream, the newline included.
// oxlint-disable-next-line no-console -- printing is what the test checks
console.log("o".repeat(LINE_BYTES));
// oxlint-disable-next-line no-console -- printing is what the test checks
console.error("e".repeat(LINE_BYTES));

bench("loud", () => 1);
