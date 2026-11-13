import { spawnSync } from "node:child_process";

/** `CI` values that mean "not a CI runner", compared lowercased. */
const NOT_CI: ReadonlySet<string> = new Set(["", "false", "0"]);

/**
 * Whether the real-Bun cases must run.
 *
 * @param bunInstalled - Whether a `bun` executable was found on `PATH`, whatever its exit status.
 * @param ci - The `CI` environment value; unset, empty, `false` and `0`, in any case, mean not CI.
 * @returns `true` when Bun is installed or `ci` marks a CI runner.
 */
export function requiresRealBun(bunInstalled: boolean, ci: string | undefined): boolean {
  return bunInstalled || (ci !== undefined && !NOT_CI.has(ci.toLowerCase()));
}

/**
 * Whether spawning `bun` found an executable. A `bun` that exits non-zero or is killed by a signal
 * still counts as found, so a broken install runs the real-Bun cases and fails loudly instead of
 * skipping them; only a spawn error coded `ENOENT` means no `bun` on `PATH`.
 *
 * @param result - The `spawnSync` result of running `bun`.
 * @returns `false` only when the spawn failed with `ENOENT`.
 */
export function bunExecutableFound(result: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error | undefined;
}): boolean {
  const { error } = result;
  return !(error !== undefined && "code" in error && error.code === "ENOENT");
}

/**
 * Whether this machine must run the real-Bun cases, spawning `bun --version` and reading the `CI`
 * environment variable.
 *
 * @returns `true` when a `bun` executable was found or `CI` marks a CI runner.
 */
export function requiresRealBunHere(): boolean {
  return requiresRealBun(bunExecutableFound(spawnSync("bun", ["--version"])), process.env["CI"]);
}
