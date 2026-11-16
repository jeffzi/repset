import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCoverageFresh } from "../scripts/check-coverage-fresh.js";

const COVERAGE_MTIME = 1_700_000_000;
const OLDER = COVERAGE_MTIME - 100;

const projects: string[] = [];

afterEach(() => {
  for (const dir of projects.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a file, creating parent directories, and sets its mtime (seconds). */
function writeFileWithMtime(path: string, content: string, mtime: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
}

/**
 * Builds a throwaway project, registered for removal after the tests, with every directory's mtime
 * set last so writing a child does not bump it.
 *
 * @param files - Each file's relative path, mapped to its mtime in seconds.
 * @param coverageMtime - The coverage report's mtime in seconds.
 * @param directories - Directories to create, each relative path mapped to its mtime in seconds;
 *   every other directory gets `OLDER`.
 * @returns The project's root directory.
 * @throws Whatever creating the directory, writing a file or setting an mtime throws.
 */
function createProject(
  files: Record<string, number>,
  coverageMtime: number,
  directories: Record<string, number> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "coverage-fresh-"));
  projects.push(dir);
  for (const [path, mtime] of Object.entries(files)) {
    writeFileWithMtime(join(dir, path), "", mtime);
  }
  for (const path of Object.keys(directories)) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  writeFileWithMtime(join(dir, "coverage", "coverage-final.json"), "{}", coverageMtime);
  // Last, because writing a child bumps its directory's mtime.
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      const path = join(entry.parentPath, entry.name);
      const mtime = directories[relative(dir, path).replaceAll(sep, "/")] ?? OLDER;
      utimesSync(path, mtime, mtime);
    }
  }
  return dir;
}

describe("checkCoverageFresh", () => {
  describe("when no input is newer than the coverage report", () => {
    it("returns without throwing", () => {
      const dir = createProject(
        {
          "src/world.ts": OLDER,
          "src/entity/spawn.ts": OLDER,
          "src/query.ts": COVERAGE_MTIME,
          "tests/entity/spawn.test.ts": OLDER,
          "tests/query.test.ts": COVERAGE_MTIME,
          "vitest.config.ts": OLDER,
        },
        COVERAGE_MTIME,
        { tests: COVERAGE_MTIME },
      );

      expect(() => {
        checkCoverageFresh(dir);
      }).not.toThrow();
    });
  });
});
