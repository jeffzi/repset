import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

import { POSIX } from "./spawn-limits.js";

/** The command's source entry. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** The `tsx` loader as a URL, which `--import` resolves from any working directory. */
export const TSX = import.meta.resolve("tsx");

/** How long a command left running at a test's end has to stop on SIGTERM, inside Vitest's hook limit. */
const STOP_GRACE_MS = 5000;

/**
 * Kills what is left of a command: on POSIX its whole process group, so a child it started dies
 * with it, and elsewhere the command alone.
 *
 * @param child - The command, started in a process group of its own on POSIX.
 * @throws The error sending the signal, unless the group has no process left.
 */
function killLeft(child: ChildProcess): void {
  if (!POSIX || child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** How a started command ended: its exit code, `null` when a signal ended it, and its stderr. */
interface Ended {
  readonly code: number | null;
  readonly stderr: string;
}

/**
 * Starts the command from source on Node, its TypeScript loaded through tsx.
 *
 * A command still running when the calling test ends, as when the test timed out, is sent SIGTERM,
 * which stops its child too. Whatever is left of it after {@link STOP_GRACE_MS}, or once it closed,
 * is killed, and the test's teardown waits for it to close.
 *
 * @param cwd - The directory the command starts in.
 * @param args - The command's arguments.
 * @param onStderr - Receives the command's stderr so far each time it grows, and a function that
 *   sends the command a signal the first time it is called.
 * @returns How the command ended.
 * @throws When the child emits `error`, as when its process cannot be started.
 */
export async function spawnCommand(
  cwd: string,
  args: readonly string[],
  onStderr: (stderr: string, stop: (signal: NodeJS.Signals) => void) => void = () => {},
): Promise<Ended> {
  const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: POSIX,
  });
  const closed = once(child, "close");
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([closed, delay(STOP_GRACE_MS, undefined, { ref: false })]);
    killLeft(child);
    await closed;
  });
  let stderr = "";
  let stopSent = false;
  // Drained so a command that prints much never blocks on a full pipe.
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onStderr(stderr, (signal) => {
      if (!stopSent) child.kill(signal);
      stopSent = true;
    });
  });
  const [code]: unknown[] = await closed;
  return { code: typeof code === "number" ? code : null, stderr };
}
