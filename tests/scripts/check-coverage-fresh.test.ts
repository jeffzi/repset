import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCoverageFresh } from "../../scripts/check-coverage-fresh.js";
import { temporaryProject } from "../helpers/temporary-dir.js";

const COVERAGE_MTIME = 1_700_000_000;
const OLDER = COVERAGE_MTIME - 100;

/** A throwaway project holding each file at its mtime and a coverage report at `coverageMtime`. */
function createProject(files: Record<string, number>, coverageMtime: number): string {
  const report = join("coverage", "coverage-final.json");
  const timeOf = { ...files, [report]: coverageMtime };
  const dir = temporaryProject("coverage-fresh-", {
    ...Object.fromEntries(Object.keys(files).map((path) => [path, ""])),
    [report]: "{}",
  });
  for (const [path, mtime] of Object.entries(timeOf)) utimesSync(join(dir, path), mtime, mtime);
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
