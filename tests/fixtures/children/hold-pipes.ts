import { spawn } from "node:child_process";

const LINGER_MS = 5000;

// Starts a process that prints `plum`, then holds stdout, stderr and file descriptor 3 open for 5 s.
spawn(
  process.execPath,
  ["-e", `process.stdout.write('plum\\n'); setTimeout(() => 0, ${LINGER_MS});`],
  { stdio: ["ignore", "inherit", "inherit", 3] },
);

// Ignores the signals it can catch, and ends by itself so a failed test leaves no process behind.
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
setTimeout(() => undefined, LINGER_MS);
