import { describe, expect, it } from "vitest";

import { exportSubpaths } from "../scripts/import-exports.js";

describe("exportSubpaths", () => {
  describe("when exports is a subpath map", () => {
    it("leaves out wildcard subpaths", () => {
      const exports = { ".": "./dist/index.js", "./features/*": "./x", "./cli": "./dist/cli.js" };

      expect(exportSubpaths(exports)).toStrictEqual([".", "./cli"]);
    });
  });
});
