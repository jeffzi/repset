import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const COVERAGE_REPORT = "coverage/coverage-final.json";
const VITEST_CONFIG = "vitest.config.ts";

function isSourceFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".d.ts");
}

/**
 * @param dir - Root to walk.
 * @param isInput - Whether a regular file, given its name, counts as an input.
 * @returns `dir`, every directory below it, and every regular file `isInput` accepts; directories
 * count because deleting or renaming a file only bumps its directory's mtime.
 * @throws The filesystem error from `readdirSync` when `dir` is missing or unreadable.
 */
function listInputs(dir: string, isInput: (name: string) => boolean): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isInput(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
  return [dir, ...entries];
}

/**
 * Fail when `src/`, `tests/`, a directory below them, a `.ts` source under `src/`, any regular
 * file under `tests/` (fixtures included), or `vitest.config.ts` is newer than the coverage
 * report. A missing report passes.
 *
 * @param projectRoot - Directory holding `src/`, `tests/`, `vitest.config.ts` and `coverage/`.
 * @throws Error naming each stale input, or the filesystem error.
 */
export function checkCoverageFresh(projectRoot: string): void {
  const coverage = statSync(join(projectRoot, COVERAGE_REPORT), { throwIfNoEntry: false });
  if (coverage === undefined) {
    return;
  }

  const inputs = [
    ...listInputs(join(projectRoot, "src"), isSourceFile),
    ...listInputs(join(projectRoot, "tests"), () => true),
    join(projectRoot, VITEST_CONFIG),
  ];
  const stale = inputs
    .filter((path) => statSync(path).mtimeMs > coverage.mtimeMs)
    .map((path) => relative(projectRoot, path).replaceAll(sep, "/"))
    .toSorted();

  if (stale.length > 0) {
    throw new Error(
      `${COVERAGE_REPORT} is older than ${stale.join(", ")} — run: task test, then task check`,
    );
  }
}

if (import.meta.main) {
  checkCoverageFresh(process.cwd());
}
