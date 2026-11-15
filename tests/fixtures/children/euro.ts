import { writeSync } from "node:fs";

// 30,000 bytes of three-byte characters, so the last 16 KiB starts inside one.
process.stdout.write("€".repeat(10_000));
writeSync(3, '{"status":"ok"}\n');
