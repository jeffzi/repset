import { writeSync } from "node:fs";

const TOTAL_BYTES = 1024 * 1024;
const TAIL_BYTES = 16 * 1024;

// A megabyte, more than one pipe read, whose last 16 KiB alone are "z".
process.stdout.write(`${"a".repeat(TOTAL_BYTES - TAIL_BYTES)}${"z".repeat(TAIL_BYTES)}`);
writeSync(3, '{"status":"ok"}\n');
