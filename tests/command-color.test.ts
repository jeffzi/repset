import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Result } from "../src/report.js";
import { formatTable } from "../src/table.js";
import {
  captured,
  command,
  type CommandIo,
  type Ended,
  failsParse,
  measuresAll,
  starter,
  stubColorTerminalEnv,
  styled,
  terminal,
  workspace,
} from "./command-harness.js";
import { failedOutcome, startsNoChild } from "./fake-children.js";
import { parseReport, reportAt } from "./report-file.js";

describe("main", () => {
  describe("when a stream would show color", () => {
    beforeEach(() => {
      stubColorTerminalEnv();
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

      expect(ended.stdout).toBe(formatTable(ended.results, { color: false }));
    });

    it.each([
      { name: "NO_COLOR is set", variable: "NO_COLOR", value: "1" },
      { name: "TERM is dumb", variable: "TERM", value: "dumb" },
    ])("prints the plain table on a terminal stdout when $name", async ({ variable, value }) => {
      vi.stubEnv(variable, value);

      const ended = await runTable([], { stdout: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results, { color: false }));
    });

    it("prints the plain table on a terminal stdout that reports one bit of color", async () => {
      const stdout = Object.assign(terminal(), { getColorDepth: () => 1 });

      const ended = await runTable([], { stdout });

      expect(ended.stdout).toBe(formatTable(ended.results, { color: false }));
    });

    it("prints the plain table on a stdout that is not a terminal while stderr is one", async () => {
      const ended = await runTable([], { stdout: captured(), stderr: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results, { color: false }));
    });

    it("colors the table on a terminal stderr under --out -, whatever stdout is", async () => {
      const { stdout, stderr } = await command(
        workspace(),
        ["sort.bench.ts", "parse.bench.ts", "--out", "-"],
        { startChild: failsParse, stdout: captured(), stderr: terminal() },
      );

      const { results } = parseReport(stdout, "stdout");
      expect({
        results: results.length,
        tableEnd: stderr.endsWith(formatTable(results, { color: true })),
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
    ])("keeps color on a terminal stderr when --no-color comes $why", async ({ args }) => {
      const { code, stderr } = await command(workspace(), args, {
        startChild: startsNoChild,
        stderr: terminal(),
      });

      expect({ code, styled: styled(stderr) }).toStrictEqual({ code: 2, styled: true });
    });

    it("prints the colored table on a terminal stdout when NO_COLOR is empty", async () => {
      vi.stubEnv("NO_COLOR", "");

      const ended = await runTable([], { stdout: terminal() });

      expect(ended.stdout).toBe(formatTable(ended.results, { color: true }));
    });

    it("keeps the METRIC lines on stdout plain while the live line shows on a terminal stderr", async () => {
      const args = ["sort.bench.ts", "parse.bench.ts", "--metric-lines"];
      const plain = await command(workspace(), args, { startChild: failsParse });

      const live = await command(workspace(), args, { startChild: failsParse, stderr: terminal() });

      expect({ styled: styled(live.stderr), stdout: live.stdout }).toStrictEqual({
        styled: true,
        stdout: plain.stdout,
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
