import { writeSync } from "node:fs";

// A megabyte, more than one pipe read, whose last 16 KiB alone are "z".
process.stdout.write(`${"a".repeat(1024 * 1024 - 16 * 1024)}${"z".repeat(16 * 1024)}`);
writeSync(3, '{"status":"ok"}\n');
