export const RUNTIMES = ["node", "bun"] as const;

export type Runtime = (typeof RUNTIMES)[number];

/**
 * Names the runtime running this process, read from the `Bun` global Bun defines, so `measure`,
 * which loads in a browser page, needs no Node builtin to tell.
 *
 * @returns `"bun"` under Bun, `"node"` otherwise.
 */
export function runningRuntime(): Runtime {
  return "Bun" in globalThis ? "bun" : "node";
}
