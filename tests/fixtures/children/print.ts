import { writeSync } from "node:fs";

process.stdout.write("plum\n");
process.stderr.write("pear\n");
writeSync(3, '{"status":"ok"}\n');
