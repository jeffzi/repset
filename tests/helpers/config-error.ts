import { expect } from "vitest";

import { ConfigError } from "../../src/options.js";

/** Asserts that `result` rejects with a `ConfigError` whose message holds or matches each of `named`. */
export async function expectConfigError(
  result: Promise<unknown>,
  named: readonly (string | RegExp)[],
): Promise<void> {
  await expect(result).rejects.toBeInstanceOf(ConfigError);
  for (const text of named) await expect(result).rejects.toThrow(text);
}
