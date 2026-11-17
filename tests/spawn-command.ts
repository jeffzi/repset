import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** The command's source entry. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** The `tsx` loader as a URL, which `--import` resolves from any working directory. */
const TSX = import.meta.resolve("tsx");

/** How a started command ended: its exit code, `null` when a signal ended it, and what it printed. */
export interface Ended {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Starts the command from source on Node, its TypeScript loaded through tsx.
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
  });
  let stdout = "";
  let stderr = "";
  let stopSent = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onStderr(stderr, (signal) => {
      if (!stopSent) child.kill(signal);
      stopSent = true;
    });
  });
  const [code]: unknown[] = await once(child, "close");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
}
