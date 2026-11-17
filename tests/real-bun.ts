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
 * Whether spawning `bun` found an executable. A broken install must run the real-Bun cases and fail
 * loudly instead of skipping them.
 *
 * @param spawnResult - The `spawnSync` result of running `bun`; only its `error` is read.
 * @returns `false` only when the spawn failed with `ENOENT` (no `bun` on `PATH`); `true` otherwise,
 * including a non-zero exit, a signal, or any other spawn error.
 */
export function bunExecutableFound(spawnResult: { error?: Error | undefined }): boolean {
  const { error } = spawnResult;
  const missingExecutable = error !== undefined && "code" in error && error.code === "ENOENT";
  return !missingExecutable;
}

/**
 * Whether this machine must run the real-Bun cases, spawning `bun --version` and reading the `CI`
 * environment variable.
 *
 * @returns `true` when a `bun` executable was found or `CI` marks a CI runner.
 */
export function requiresRealBunHere(): boolean {
  const bunInstalled = bunExecutableFound(spawnSync("bun", ["--version"]));
  return requiresRealBun(bunInstalled, process.env["CI"]);
}

/** A runtime real-process tests cover, and whether it must run on this machine. */
export interface RuntimeHere {
  readonly runtime: "node" | "bun";
  readonly here: boolean;
}

/** The runtimes real-process tests cover, each with whether it must run on this machine. */
export function runtimesHere(): readonly RuntimeHere[] {
  return [
    { runtime: "node", here: true },
    { runtime: "bun", here: requiresRealBunHere() },
  ];
}
