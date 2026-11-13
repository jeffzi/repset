import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const COVERAGE_REPORT = "coverage/coverage-final.json";
const VITEST_CONFIG = "vitest.config.ts";

function isSourceFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".d.ts");
}

function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * @param dir - Root to walk.
 * @returns `dir`, every directory below it, and every `.ts` source; directories count because
 * deleting or renaming a file only bumps its directory's mtime.
 */
function listInputs(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isSourceFile(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
  return [dir, ...entries];
}

/**
 * Fail when `src/`, `tests/`, a directory or `.ts` file below them, or `vitest.config.ts` is
 * newer than the coverage report. A missing report passes.
 *
 * @param projectRoot - Directory holding `src/` and `coverage/`.
 * @throws Error naming each stale input, or the filesystem error.
 */
export function checkCoverageFresh(projectRoot: string): void {
  const coverage = statSync(join(projectRoot, COVERAGE_REPORT), { throwIfNoEntry: false });
  if (coverage === undefined) {
    return;
  }

  const testsDir = join(projectRoot, "tests");
  const vitestConfig = join(projectRoot, VITEST_CONFIG);
  const inputs = [
    ...listInputs(join(projectRoot, "src")),
    ...(exists(testsDir) ? listInputs(testsDir) : []),
    ...(exists(vitestConfig) ? [vitestConfig] : []),
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

const entry = process.argv[1];
if (
  entry !== undefined &&
  exists(entry) &&
  realpathSync(entry) === fileURLToPath(import.meta.url)
) {
  checkCoverageFresh(process.cwd());
}
