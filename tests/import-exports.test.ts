import { describe, expect, it } from "vitest";

import { exportSubpaths } from "../scripts/import-exports.js";

describe("exportSubpaths", () => {
  describe("when exports is a subpath map", () => {
    it.each(["./features/*", "./package.json"])("leaves out %s", (skipped) => {
      const exports = { ".": "./dist/index.js", [skipped]: "./x", "./cli": "./dist/cli.js" };

      expect(exportSubpaths(exports)).toStrictEqual([".", "./cli"]);
    });
  });

  describe("when exports has no subpath keys", () => {
    it.each([
      { kind: "a string", exports: "./dist/index.js" },
      { kind: "a conditions object", exports: { import: "./a.js", types: "./a.d.ts" } },
    ])("returns the root subpath for $kind", ({ exports }) => {
      expect(exportSubpaths(exports)).toStrictEqual(["."]);
    });
  });

  describe("when exports is undefined", () => {
    it("throws that the package has no exports", () => {
      expect(() => exportSubpaths(undefined)).toThrow(Error);
    });
  });
});
