import { describe, expect, it } from "vitest";

import { bunExecutableFound, requiresRealBun } from "./real-bun.js";

/** Unset and `"FALSE"` mean not CI (`"FALSE"` shows the comparison ignores case); `"true"` means CI. */
const CI_VALUES = [
  { ci: undefined, isCi: false },
  { ci: "FALSE", isCi: false },
  { ci: "true", isCi: true },
];

/** Builds a spawn error carrying a Node errno code, as `spawnSync` reports it. */
function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawnSync bun ${code}`), { code });
}

describe("requiresRealBun", () => {
  describe("when Bun is installed", () => {
    it("returns true without CI", () => {
      expect(requiresRealBun(true, undefined)).toBe(true);
    });
  });

  describe("when Bun is missing", () => {
    it.each(CI_VALUES)("with CI=$ci, returns $isCi", ({ ci, isCi }) => {
      expect(requiresRealBun(false, ci)).toBe(isCi);
    });
  });
});

describe("bunExecutableFound", () => {
  describe("when no bun is on PATH", () => {
    it("returns false", () => {
      const result = { error: spawnError("ENOENT") };

      expect(bunExecutableFound(result)).toBe(false);
    });
  });

  describe("when a bun executable ran", () => {
    it("returns true when the spawn reported no error", () => {
      expect(bunExecutableFound({ error: undefined })).toBe(true);
    });
  });

  describe("when spawning fails for a reason other than a missing executable", () => {
    it("returns true", () => {
      const result = { error: spawnError("EACCES") };

      expect(bunExecutableFound(result)).toBe(true);
    });
  });
});
