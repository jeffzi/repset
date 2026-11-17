/** The part of Bun's `bun:jsc` module `measure` uses. */
declare module "bun:jsc" {
  /** Keeps JavaScriptCore from inlining `fn` into its callers. */
  export function noInline(fn: (...args: never[]) => unknown): void;
}
