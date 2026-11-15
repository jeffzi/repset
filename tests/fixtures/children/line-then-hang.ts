import { writeSync } from "node:fs";

writeSync(3, '{"status":"ok"}\n');

// Ignores the signals it can catch, and ends by itself so a failed test leaves no process behind.
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
setTimeout(() => undefined, 5000);
