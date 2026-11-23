import { beforeEach, describe, expect, it } from "vitest";

import {
  clearShellEnv,
  command,
  linesOf,
  naming,
  startsNoCase,
  workspace,
} from "./command-harness.js";
import { startsNoChild } from "./fake-children.js";

const FILES = ["sort.bench.ts", "parse.bench.ts"];

describe("main", () => {
  beforeEach(() => {
    clearShellEnv();
  });

  describe("when --measure holds a bad list", () => {
    it.each([
      { why: "an unknown name", mode: [], list: "time,banana", named: ["measure", "banana"] },
      { why: "a name twice", mode: [], list: "time,time", named: ["measure", "time"] },
      { why: "no name", mode: [], list: "", named: ["measure"] },
      { why: "an unknown name with --once", mode: ["--once"], list: "pear", named: ["pear"] },
      { why: "an unknown name with --list", mode: ["--list"], list: "pear", named: ["pear"] },
    ])(
      "exits 2 on $why, naming it on stderr, with nothing on stdout and no child",
      async ({ mode, list, named }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(
          dir,
          [...mode, ...FILES, "--measure", list],
          { startChild: startsNoChild },
        );

        expect({ code, stdout, stderr }).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: naming(...named),
        });
      },
    );
  });

  describe("when --measure holds a good list", () => {
    it("prints each selected case id with --list, running no case", async () => {
      const dir = workspace();

      const ended = await command(dir, ["--list", ...FILES, "--measure", "memory,time"], {
        startChild: startsNoCase,
      });

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "sort/fast\nparse/fast\n",
      });
    });

    it("prints each selected case id with --list on Bun when memory alone is measured", async () => {
      const dir = workspace();

      const ended = await command(
        dir,
        ["--list", ...FILES, "--runtime", "bun", "--measure", "memory"],
        { startChild: startsNoCase },
      );

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "sort/fast\nparse/fast\n",
      });
    });

    it("prints one line per case with --once, exiting 0", async () => {
      const dir = workspace();

      const { code, stdout } = await command(dir, ["--once", ...FILES, "--measure", "memory"]);

      expect({ code, lines: linesOf(stdout) }).toStrictEqual({
        code: 0,
        lines: [naming("node", "sort/fast"), naming("node", "parse/fast")],
      });
    });
  });
});
