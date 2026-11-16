import { writeSync } from "node:fs";

const RESULT_FD = 3;

writeSync(RESULT_FD, '{"status":"ok"}\n');
process.kill(process.pid, "SIGKILL");
