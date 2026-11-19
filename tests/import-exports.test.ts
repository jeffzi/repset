import { describe, expect, it } from "vitest";

import { exportSubpaths } from "../scripts/import-exports.js";

describe("exportSubpaths", () => {
  describe("when exports is a subpath map", () => {
    it("returns every subpath key", () => {
      const exports = {
        ".": "./dist/index.js",
        "./features/*": "./x",
        "./package.json": "./package.json",
      };

      expect(exportSubpaths(exports)).toStrictEqual([".", "./features/*", "./package.json"]);
    });
  });
});
