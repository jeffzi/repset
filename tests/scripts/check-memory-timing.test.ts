import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-memory-timing.js";
import type { Readers } from "../../scripts/check-memory-timing.js";
import { READING } from "../helpers/repset-reading.js";

/** Readers for every body: the same reading with memory measured as without. */
const READERS: Readers = {
  alone: () => READING,
  withMemory: () => READING,
};

describe("runCheck", () => {
  describe("when no body's timing differs with memory measured", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });
  });

  describe("when timing with memory measured reads higher than timing alone in every pair", () => {
    it("returns 1", () => {
      const readers: Readers = {
        alone: () => READING,
        withMemory: () => ({ ...READING, median: 1100 }),
      };

      const status = runCheck(readers, () => undefined);

      expect(status).toBe(1);
    });
  });
});
