import { writeSync } from "node:fs";

writeSync(3, '{"status":"ok"}\n');
process.exitCode = 1;
