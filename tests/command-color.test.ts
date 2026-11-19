import { stripVTControlCharacters } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatTable } from "../src/table.js";
import {
  captured,
  command,
  type CommandIo,
  failsParse,
  measuresAll,
  runToStdout,
  runWithReport,
  starter,
  stubColorTerminalEnv,
  styled,
  terminal,
  workspace,
} from "./command-harness.js";
import { failedOutcome, startsNoChild } from "./fake-children.js";

describe("main", () => {
  describe("when a stream would show color", () => {
    beforeEach(() => {
      stubColorTerminalEnv();
    });

    it.each<{
      readonly why: string;
      readonly args: readonly string[];
      readonly env: readonly [variable: string, value: string | undefined];
      readonly io: () => CommandIo;
      readonly table: "colored" | "plain";
    }>([
      {
        why: "a terminal stdout",
        args: [],
        env: ["NO_COLOR", undefined],
        io: () => ({ stdout: terminal() }),
        table: "colored",
      },
      {
        why: "a terminal stdout when NO_COLOR is empty",
        args: [],
        env: ["NO_COLOR", ""],
        io: () => ({ stdout: terminal() }),
        table: "colored",
      },
      {
        why: "a terminal stdout under --no-color",
        args: ["--no-color"],
        env: ["NO_COLOR", undefined],
        io: () => ({ stdout: terminal() }),
        table: "plain",
      },
      {
        why: "a terminal stdout when NO_COLOR is set",
        args: [],
        env: ["NO_COLOR", "1"],
        io: () => ({ stdout: terminal() }),
        table: "plain",
      },
      {
        why: "a terminal stdout when TERM is dumb",
        args: [],
        env: ["TERM", "dumb"],
        io: () => ({ stdout: terminal() }),
        table: "plain",
      },
      {
        why: "a terminal stdout that reports one bit of color",
        args: [],
        env: ["NO_COLOR", undefined],
        io: () => ({ stdout: Object.assign(terminal(), { getColorDepth: () => 1 }) }),
        table: "plain",
      },
      {
        why: "a stdout that is not a terminal while stderr is one",
        args: [],
        env: ["NO_COLOR", undefined],
        io: () => ({ stdout: captured(), stderr: terminal() }),
        table: "plain",
      },
    ])("prints the $table table on $why", async ({ args, env, io, table }) => {
      vi.stubEnv(...env);
      const color = table === "colored";

      const ended = await runWithReport(args, { startChild: failsParse, ...io() });

      expect({ styled: styled(ended.stdout), stdout: ended.stdout }).toStrictEqual({
        styled: color,
        stdout: formatTable(ended.report.results, ended.report.contests, { color }),
      });
    });

    it("colors the table on a terminal stderr under --output -, whatever stdout is", async () => {
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

    it("colors the repset: prefix of an error line on a terminal stderr", async () => {
      const { code, stderr } = await command(workspace(), ["--banana"], {
        startChild: startsNoChild,
        stderr: terminal(),
      });

      expect({
        code,
        styled: styled(stderr),
        visible: stripVTControlCharacters(stderr),
      }).toStrictEqual({ code: 2, styled: true, visible: expect.stringMatching(/^repset:/u) });
    });

    it("prints a plain repset: prefix when --no-color comes beside a wrong argument", async () => {
      const { code, stderr } = await command(workspace(), ["--no-color", "--banana"], {
        startChild: startsNoChild,
        stderr: terminal(),
      });

      expect({ code, styled: styled(stderr), stderr }).toStrictEqual({
        code: 2,
        styled: false,
        stderr: expect.stringMatching(/^repset:/u),
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

    it("aligns a colored multi-line --once failure as the plain one", async () => {
      const failsOnTwoLines = starter((request, runtime, options) =>
        request.id === "parse/fast"
          ? failedOutcome("fn", "kiwi\nplum")
          : measuresAll(runtime, request, options),
      );
      const args = ["--once", "sort.bench.ts", "parse.bench.ts"];
      const plain = await command(workspace(), [...args, "--no-color"], {
        startChild: failsOnTwoLines,
        stdout: terminal(),
      });

      const colored = await command(workspace(), args, {
        startChild: failsOnTwoLines,
        stdout: terminal(),
      });

      expect({
        styled: styled(colored.stdout),
        visible: stripVTControlCharacters(colored.stdout),
      }).toStrictEqual({ styled: true, visible: plain.stdout });
    });
  });
});
