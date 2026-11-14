/** The runtimes `measure` runs on. */
export type Runtime = "node" | "bun";

/**
 * Names the runtime running `measure`, read from the `Bun` global Bun defines, so `measure` needs
 * no Node builtin to tell.
 *
 * @returns `"bun"` under Bun, `"node"` otherwise.
 */
export function runningRuntime(): Runtime {
  return "Bun" in globalThis ? "bun" : "node";
}
