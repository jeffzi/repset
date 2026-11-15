/**
 * The config file's type and `defineConfig`.
 *
 * Every measuring child loads the package entry, which re-exports this module, so it imports no
 * `node:` module and nothing at run time. Loading and checking a config belong to the parent.
 */

/** The runtimes a run can use. */
type Runtime = "node" | "bun";

/** The options a config file stores. Each is optional; `undefined` counts as absent. */
export interface Config {
  /** Globs for benchmark files, relative to the config file. `node_modules` is never searched. */
  readonly include?: readonly string[] | undefined;
  /** The runtimes a run uses. */
  readonly runtimes?: readonly Runtime[] | undefined;
  /** Timing lasts at least this many milliseconds. */
  readonly minTime?: number | undefined;
  /** Timing takes at least this many samples. */
  readonly minSamples?: number | undefined;
  /** The longest one child may run, in milliseconds; a child that passes it fails its case. */
  readonly timeout?: number | undefined;
  /** A module Node children import first, such as a TypeScript loader. Bun children ignore it. */
  readonly nodeImport?: string | undefined;
}

/** Returns `config` unchanged: it types a config file, and the parent checks it on load. */
export function defineConfig(config: Config): Config {
  return config;
}
