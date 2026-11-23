import { beforeEach, describe, expect, it } from "vitest";

import {
  clearShellEnv,
  command,
  FILES,
  naming,
  startsNoCase,
  workspace,
} from "./command-harness.js";
import { startsNoChild } from "./fake-children.js";

describe("main", () => {
  beforeEach(() => {
    clearShellEnv();
  });

  describe("when --measure holds a bad list", () => {
    it.each([
      { why: "an unknown name", list: "time,banana", named: ["measure", "banana"] },
      { why: "no name", list: "", named: ["measure"] },
    ])(
      "exits 2 on $why, naming it on stderr, with nothing on stdout and no child",
      async ({ list, named }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(dir, [...FILES, "--measure", list], {
          startChild: startsNoChild,
        });

        expect({ code, stdout, stderr }).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: naming(...named),
        });
      },
    );
  });

  describe("when --measure holds a good list", () => {
    it("accepts it, exiting 0 with --list, running no case", async () => {
      const dir = workspace();

      const { code } = await command(dir, ["--list", ...FILES, "--measure", "memory,time"], {
        startChild: startsNoCase,
      });

      expect(code).toBe(0);
    });
  });
});
