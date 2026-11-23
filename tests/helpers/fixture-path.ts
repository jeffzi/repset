import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, where the tests start processes from. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The absolute path of `dir` under `tests/fixtures/`, or of the entry `names` give inside it. */
export function fixturePath(dir: string, ...names: readonly string[]): string {
  return join(FIXTURES, dir, ...names);
}
