import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCoverageFresh } from "../scripts/check-coverage-fresh.js";
import { temporaryDir } from "./temporary-dir.js";

const COVERAGE_MTIME = 1_700_000_000;
const OLDER = COVERAGE_MTIME - 100;

/** Writes a file, creating parent directories, and sets its mtime (seconds). */
function writeFileWithMtime(path: string, content: string, mtime: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
}

/** A throwaway project holding each file at its mtime and a coverage report at `coverageMtime`. */
function createProject(files: Record<string, number>, coverageMtime: number): string {
  const dir = temporaryDir("coverage-fresh-");
  for (const [path, mtime] of Object.entries(files)) {
    writeFileWithMtime(join(dir, path), "", mtime);
  }
  writeFileWithMtime(join(dir, "coverage", "coverage-final.json"), "{}", coverageMtime);
  // Last, because writing a child bumps its directory's mtime.
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) utimesSync(join(entry.parentPath, entry.name), OLDER, OLDER);
  }
  return dir;
}

describe("checkCoverageFresh", () => {
  describe("when no input is newer than the coverage report", () => {
    it("returns without throwing", () => {
      const dir = createProject(
        {
          "src/query.ts": COVERAGE_MTIME,
          "tests/query.test.ts": OLDER,
          "vitest.config.ts": OLDER,
        },
        COVERAGE_MTIME,
      );

      const check = (): void => {
        checkCoverageFresh(dir);
      };

      expect(check).not.toThrow();
    });
  });
});
