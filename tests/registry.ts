/** The `globalThis` slot every copy of repset registers its cases in. */
export const REGISTRY = Symbol.for("repset.registry");

/** Empties the registry, so the next registration starts a fresh one. */
export function resetRegistry(): void {
  Reflect.deleteProperty(globalThis, REGISTRY);
}
