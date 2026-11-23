import { beforeEach, describe, expect, it } from "vitest";

import { formatTable } from "../src/table.js";
import {
  captured,
  clearShellEnv,
  command,
  type CommandIo,
  failsParse,
  FILES,
  linesOf,
  naming,
  runToStdout,
  runWithReport,
  stubColorTerminalEnv,
  styled,
  terminal,
  workspace,
} from "./helpers/command-harness.js";
import { startsNoChild } from "./helpers/fake-children.js";

describe("main", () => {
  describe("when a stream would show color", () => {
    beforeEach(() => {
      clearShellEnv();
      stubColorTerminalEnv();
    });

    it.each<{
      readonly why: string;
      readonly args: readonly string[];
      readonly io: () => CommandIo;
      readonly table: "colored" | "plain";
    }>([
      {
        why: "a terminal stdout",
        args: [],
        io: () => ({ stdout: terminal() }),
        table: "colored",
      },
      {
        why: "a terminal stdout under --no-color",
        args: ["--no-color"],
        io: () => ({ stdout: terminal() }),
        table: "plain",
      },
      {
        why: "a terminal stdout that reports one bit of color",
        args: [],
        io: () => ({ stdout: Object.assign(terminal(), { getColorDepth: () => 1 }) }),
        table: "plain",
      },
      {
        why: "a stdout that is not a terminal while stderr is one",
        args: [],
        io: () => ({ stdout: captured(), stderr: terminal() }),
        table: "plain",
      },
    ])("prints the $table table on $why", async ({ args, io, table }) => {
      const color = table === "colored";

      const ended = await runWithReport(args, { startChild: failsParse, ...io() });

      expect({ styled: styled(ended.stdout), stdout: ended.stdout }).toStrictEqual({
        styled: color,
        stdout: formatTable(ended.report.results, ended.report.contests, { color }),
      });
    });

    it("colors the table on a terminal stderr under --output -, even when stdout is not a terminal", async () => {
      const { results, stderr } = await runToStdout({
        startChild: failsParse,
        stdout: captured(),
        stderr: terminal(),
      });

      expect({
        results: results.length,
        tableEnd: stderr.endsWith(formatTable(results, [], { color: true })),
      }).toStrictEqual({ results: 2, tableEnd: true });
    });

    it("prints a plain error line when --no-color comes beside a wrong argument", async () => {
      const { code, stderr } = await command(workspace(), ["--no-color", "--banana"], {
        startChild: startsNoChild,
        stderr: terminal(),
      });

      expect({ code, styled: styled(stderr), stderr }).toStrictEqual({
        code: 2,
        styled: false,
        stderr: naming("banana"),
      });
    });

    it.each([
      { why: "after a -- terminator", args: ["--", "--no-color"] },
      { why: "as the value of a value flag", args: ["--filter", "--no-color", "--banana"] },
      { why: "as the value of a short value flag", args: ["-o", "--no-color", "--banana"] },
    ])("keeps color on a terminal stderr when --no-color comes $why", async ({ args }) => {
      const { code, stderr } = await command(workspace(), args, {
        startChild: startsNoChild,
        stderr: terminal(),
      });

      expect({ code, styled: styled(stderr) }).toStrictEqual({ code: 2, styled: true });
    });

    it("colors a --once failure on a terminal stdout", async () => {
      const args = ["--once", ...FILES];

      const colored = await command(workspace(), args, {
        startChild: failsParse,
        stdout: terminal(),
      });

      const failure = linesOf(colored.stdout).find((line) => line.includes("parse/fast")) ?? "";
      expect(styled(failure)).toBe(true);
    });
  });
});
