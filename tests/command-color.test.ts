import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Result } from "../src/report.js";
import { formatTable } from "../src/table.js";
import {
  captured,
  command,
  type CommandIo,
  type Ended,
  failsParse,
  linesOf,
  measuresAll,
  naming,
  starter,
  styled,
  terminal,
  workspace,
} from "./command-harness.js";
import { failedOutcome, startsNoChild } from "./fake-children.js";
import { parseReport, reportAt } from "./report-file.js";

describe("main", () => {
  describe("when a stream would show color", () => {
    beforeEach(() => {
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", undefined);
      vi.stubEnv("TERM", "xterm-256color");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** Runs two files with the report in `report.json`, returning what ended and the results. */
    async function runTable(
      args: readonly string[],
      io: CommandIo,
    ): Promise<Ended & { readonly results: readonly Result[] }> {
      const dir = workspace();
      const ended = await command(
        dir,
        ["sort.bench.ts", "parse.bench.ts", "--out", "report.json", ...args],
        { startChild: failsParse, ...io },
      );
      return { ...ended, results: reportAt(join(dir, "report.json")).results };
    }

    it("prints the colored table on a terminal stdout", async () => {
      const ended = await runTable([], { stdout: terminal() });

      expect({ styled: styled(ended.stdout), stdout: ended.stdout }).toStrictEqual({
        styled: true,
        stdout: formatTable(ended.results, { color: true }),
      });
    });

    it("prints the plain table on a terminal stdout under --no-color", async () => {
      const ended = await runTable(["--no-color"], { stdout: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results));
    });

    it.each([
      { name: "NO_COLOR is set", variable: "NO_COLOR", value: "1" },
      { name: "TERM is dumb", variable: "TERM", value: "dumb" },
    ])("prints the plain table on a terminal stdout when $name", async ({ variable, value }) => {
      vi.stubEnv(variable, value);

      const ended = await runTable([], { stdout: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results));
    });

    it("prints the plain table on a terminal stdout that reports one bit of color", async () => {
      const stdout = Object.assign(terminal(), { getColorDepth: () => 1 });

      const ended = await runTable([], { stdout });

      expect(ended.stdout).toBe(formatTable(ended.results));
    });

    it("prints the plain table on a stdout that is not a terminal while stderr is one", async () => {
      const ended = await runTable([], { stdout: captured(), stderr: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results));
    });

    it("colors the table on a terminal stderr but never the report on a terminal stdout under --out -", async () => {
      const { stdout, stderr } = await command(
        workspace(),
        ["sort.bench.ts", "parse.bench.ts", "--out", "-"],
        { startChild: failsParse, stdout: terminal(), stderr: terminal() },
      );

      const { results } = parseReport(stdout, "stdout");
      expect({
        stdoutStyled: styled(stdout),
        stderrStyled: styled(stderr),
        tableEnd: stderr.endsWith(formatTable(results, { color: true })),
      }).toStrictEqual({ stdoutStyled: false, stderrStyled: true, tableEnd: true });
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

    it("colors the --once status words on a terminal stdout", async () => {
      const { code, stdout } = await command(
        workspace(),
        ["--once", "sort.bench.ts", "parse.bench.ts"],
        {
          startChild: failsParse,
          stdout: terminal(),
        },
      );

      expect({
        code,
        styled: styled(stdout),
        lines: linesOf(stripVTControlCharacters(stdout)),
      }).toStrictEqual({
        code: 1,
        styled: true,
        lines: [
          naming("ok", "node", "sort/fast"),
          naming("failed", "node", "parse/fast", "fn", "kiwi"),
        ],
      });
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
