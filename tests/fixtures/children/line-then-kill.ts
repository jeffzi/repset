import { writeSync } from "node:fs";

writeSync(3, '{"status":"ok"}\n');
process.kill(process.pid, "SIGKILL");
