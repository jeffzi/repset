/** The engines `measure` runs on. */
export type Engine = "node" | "bun";

/**
 * Names the engine running `measure`, read from the `Bun` global Bun defines, so `measure` needs
 * no Node builtin to tell.
 *
 * @returns `"bun"` under Bun, `"node"` otherwise.
 */
export function runningEngine(): Engine {
  return "Bun" in globalThis ? "bun" : "node";
}
