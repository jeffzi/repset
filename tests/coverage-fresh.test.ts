import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCoverageFresh } from "../scripts/check-coverage-fresh.js";

const COVERAGE_MTIME = 1_700_000_000;
const OLDER = COVERAGE_MTIME - 100;
const NEWER = COVERAGE_MTIME + 100;

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
 * Builds a throwaway project with the given files (relative path → mtime in seconds) and an
 * optional coverage report. Directories default to OLDER; `directories` creates and overrides them.
 */
function createProject(
  files: Record<string, number>,
  coverageMtime?: number,
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
  if (coverageMtime !== undefined) {
    writeFileWithMtime(join(dir, "coverage", "coverage-final.json"), "{}", coverageMtime);
  }
  // Last, because writing a child bumps its directory's mtime.
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      const path = join(entry.parentPath, entry.name);
      const mtime = directories[relative(dir, path)] ?? OLDER;
      utimesSync(path, mtime, mtime);
    }
  }
  return dir;
}

describe("checkCoverageFresh", () => {
  describe("when no coverage report exists", () => {
    it("returns without throwing", () => {
      const dir = createProject({ "src/world.ts": NEWER });

      expect(() => {
        checkCoverageFresh(dir);
      }).not.toThrow();
    });
  });

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

  describe("when an input is newer than the coverage report", () => {
    it.each(["src/entity/spawn.ts", "tests/entity/spawn.test.ts", "vitest.config.ts"])(
      "throws naming %s",
      (stale) => {
        const dir = createProject({ "src/world.ts": OLDER, [stale]: NEWER }, COVERAGE_MTIME);

        expect(() => {
          checkCoverageFresh(dir);
        }).toThrow(`older than ${stale} —`);
      },
    );

    it("names every stale input in sorted order", () => {
      const dir = createProject(
        {
          "vitest.config.ts": NEWER,
          "tests/world.test.ts": NEWER,
          "src/world.ts": NEWER,
          "src/entity/spawn.ts": NEWER,
          "src/query.ts": OLDER,
        },
        COVERAGE_MTIME,
      );

      expect(() => {
        checkCoverageFresh(dir);
      }).toThrow(
        /src\/entity\/spawn\.ts[\s\S]*src\/world\.ts[\s\S]*tests\/world\.test\.ts[\s\S]*vitest\.config\.ts/,
      );
    });

    it.each(["src", "tests/entity"])("throws naming the directory %s", (stale) => {
      const dir = createProject(
        { "src/world.ts": OLDER, "tests/entity/spawn.test.ts": OLDER },
        COVERAGE_MTIME,
        { [stale]: NEWER },
      );

      expect(() => {
        checkCoverageFresh(dir);
      }).toThrow(`older than ${stale} —`);
    });

    it("names stale directories among the sorted stale files", () => {
      const dir = createProject(
        { "src/world.ts": NEWER, "src/entity/spawn.ts": OLDER, "tests/world.test.ts": NEWER },
        COVERAGE_MTIME,
        { "src/entity": NEWER, tests: NEWER },
      );

      expect(() => {
        checkCoverageFresh(dir);
      }).toThrow("older than src/entity, src/world.ts, tests, tests/world.test.ts —");
    });
  });

  describe("when only files that are not TypeScript sources are newer", () => {
    it.each(["src/notes.md", "src/types.d.ts"])("ignores %s", (ignored) => {
      const dir = createProject({ "src/world.ts": OLDER, [ignored]: NEWER }, COVERAGE_MTIME);

      expect(() => {
        checkCoverageFresh(dir);
      }).not.toThrow();
    });
  });

  describe("when reading an input fails", () => {
    it("propagates the filesystem error", () => {
      const dir = createProject({ "src/world.ts": OLDER, tests: OLDER }, COVERAGE_MTIME);

      expect(() => {
        checkCoverageFresh(dir);
      }).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    });

    it("propagates the error of a missing src directory", () => {
      const dir = createProject({}, COVERAGE_MTIME);

      expect(() => {
        checkCoverageFresh(dir);
      }).toThrow(expect.objectContaining({ code: "ENOENT" }));
    });
  });
});
