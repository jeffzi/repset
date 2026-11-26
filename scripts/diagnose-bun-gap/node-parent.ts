// A Node parent that starts Bun on one script the way repset's parent starts a Bun child, so a timing
// taken under it differs from one taken under repset only by what the parent does while it waits:
//
//   node scripts/diagnose-bun-gap/node-parent.ts <script> <args…>
//
// It finds Bun and builds Bun's flags with repset's own functions, spawns asynchronously with pipes
// on stdout, stderr and descriptor 3 and a data handler on each, and waits for the child to exit.
// It then writes the child's stdout to its own and exits with the child's status. A child that
// cannot start, or that a signal ends, makes it exit 1 with a message on stderr naming the script;
// a Bun missing from `PATH` stops it before the spawn with `findRuntime`'s error.
//
// Plain Node runs it with no loader, so it holds only erasable type syntax and imports only `node:`
// modules and the built `dist/` modules: `task build` writes `dist/` first.
import { spawn } from "node:child_process";

import { childRuntimeFlags, findRuntime, howItEnded } from "../../dist/children.js";
import { DEFAULT_TIMEOUT } from "../../dist/options.js";

const [script, ...args] = process.argv.slice(2);
if (script === undefined) {
  process.stderr.write("usage: node-parent.ts <script> <args…>\n");
  process.exitCode = 2;
} else {
  const bun = await findRuntime("bun", { timeout: DEFAULT_TIMEOUT });
  const child = spawn(bun.executable, [...childRuntimeFlags("bun", undefined), script, ...args], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // repset's parent decodes stdout and stderr and reads descriptor 3 as they arrive; doing the same
  // keeps that work in this parent, and keeps a full pipe from blocking the child.
  let stdout = "";
  child.stdout?.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr?.setEncoding("utf8").on("data", () => undefined);
  child.stdio[3]?.on("data", () => undefined);

  let failedToStart = false;
  child.on("error", (error) => {
    failedToStart = true;
    process.stderr.write(`could not start Bun on ${script}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (failedToStart) return;
    process.stdout.write(stdout);
    if (code === null) {
      process.stderr.write(`${howItEnded(`Bun on ${script}`, { kind: "exit", code, signal })}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code;
  });
}
