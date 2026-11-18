import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Result } from "../src/report.js";
import { formatTable, metricLine } from "../src/table.js";
import {
  blockWrites,
  captured,
  command,
  type Ended,
  failsParse,
  linesOf,
  measuresAll,
  naming,
  starter,
  startsNoCase,
  terminal,
  unblockWrites,
  VERSION,
  workspace,
} from "./command-harness.js";
import {
  failedOutcome,
  type FindRuntime,
  ranOnce,
  starter as fakeStarter,
  type StartChild,
  startsNoChild,
  stopped,
} from "./fake-children.js";
import { parseReport, reportAt } from "./report-file.js";
import { temporaryDir } from "./temporary-dir.js";

describe("main", () => {
  describe("when every flag is given", () => {
    it("hands the positional files, --runtime, --filter, --min-time, --min-samples, --timeout, --node-import and --out to the run", async () => {
      const dir = workspace();

      const { code } = await command(dir, [
        "sort.bench.ts",
        "--runtime",
        "bun,node",
        "--filter",
        "fast",
        "--min-time",
        "2.5",
        "--min-samples",
        "8",
        "--timeout",
        "1234",
        "--node-import",
        "tsx",
        "--out",
        "report.json",
      ]);

      const { runtimes, files, filter, minTime, minSamples, timeout, nodeImport } = reportAt(
        join(dir, "report.json"),
      ).options;
      expect({
        code,
        options: { runtimes, files, filter, minTime, minSamples, timeout, nodeImport },
      }).toStrictEqual({
        code: 0,
        options: {
          runtimes: ["bun", "node"],
          files: ["sort.bench.ts"],
          filter: "fast",
          minTime: 2.5,
          minSamples: 8,
          timeout: 1234,
          nodeImport: "tsx",
        },
      });
    });
  });

  describe("when a value flag is given twice", () => {
    it("hands the run the last value", async () => {
      const dir = workspace();

      const { code } = await command(dir, [
        "--filter",
        "sort",
        "--filter",
        "parse",
        "--out",
        "report.json",
      ]);

      expect({ code, filter: reportAt(join(dir, "report.json")).options.filter }).toStrictEqual({
        code: 0,
        filter: "parse",
      });
    });
  });

  describe("when the command line is wrong", () => {
    it.each([
      { why: "an unknown flag", args: ["--banana"] },
      { why: "a value flag missing its value", args: ["--filter"] },
      { why: "a value flag missing its value after --help", args: ["--help", "--filter"] },
      { why: "an exponent", args: ["--min-time", "1e3"] },
      { why: "an empty number", args: ["--min-time", ""] },
      { why: "--metric-lines with --out -", args: ["--metric-lines", "--out", "-"] },
      { why: "--list with --once", args: ["--list", "--once"] },
    ])(
      "exits 2 on $why with a message on stderr, nothing on stdout, no child",
      async ({ args }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

        expect({ code, stdout, printed: stderr.length > 0 }).toStrictEqual({
          code: 2,
          stdout: "",
          printed: true,
        });
      },
    );

    it.each(["min-time", "min-samples", "timeout"])(
      "exits 2 on a --%s that is not decimal, naming the flag and the value",
      async (flag) => {
        const { code, stderr } = await command(workspace(), [`--${flag}`, "1e3"], {
          startChild: startsNoChild,
        });

        expect({
          code,
          named: stderr.includes(`--${flag}`) && stderr.includes('"1e3"'),
        }).toStrictEqual({ code: 2, named: true });
      },
    );

    it("prints a Commander error behind the repset: prefix alone", async () => {
      const { code, stderr } = await command(workspace(), ["--banana"], {
        startChild: startsNoChild,
      });

      expect({
        code,
        prefix: stderr.startsWith("repset: "),
        commander: stderr.includes("error: "),
      }).toStrictEqual({ code: 2, prefix: true, commander: false });
    });

    it("exits 2 on an unknown --runtime name, naming the value", async () => {
      const { code, stderr } = await command(workspace(), ["--runtime", "node,banana"], {
        startChild: startsNoChild,
      });

      expect({ code, named: stderr.includes("node,banana") }).toStrictEqual({
        code: 2,
        named: true,
      });
    });
  });

  describe("when a file's listing fails", () => {
    it("prints a failed listing's stack, then its output, then the file, phase and message last", async () => {
      const dir = workspace();
      const failsListing: StartChild = async () => ({
        status: "failed",
        error: { phase: "load", message: "kiwi", stack: "at plum", teardownError: null },
        output: "pear\n",
      });

      const { code, stdout, stderr } = await command(dir, ["sort.bench.ts"], {
        startChild: failsListing,
      });

      const at = (text: string): number => stderr.indexOf(text);
      expect({
        code,
        stdout,
        stackThenOutput: at("at plum") >= 0 && at("at plum") < at("pear"),
        last: linesOf(stderr).at(-1),
      }).toStrictEqual({
        code: 2,
        stdout: "",
        stackThenOutput: true,
        last: naming("sort.bench.ts", "load", "kiwi"),
      });
    });

    it("prints no stack for a failed listing that has none", async () => {
      const dir = workspace();
      const failsListing: StartChild = async () => ({
        status: "failed",
        error: { phase: "load", message: "kiwi", stack: null, teardownError: null },
        output: "",
      });

      const { code, stderr } = await command(dir, ["sort.bench.ts"], {
        startChild: failsListing,
      });

      expect({ code, mentionsNull: stderr.includes("null") }).toStrictEqual({
        code: 2,
        mentionsNull: false,
      });
    });
  });

  describe("on an error that is not a ConfigError", () => {
    it("rejects with that error instead of exiting 2", async () => {
      const error = new Error("kiwi");
      const findsNone: FindRuntime = async () => {
        throw error;
      };

      const ended = command(workspace(), ["sort.bench.ts"], { findRuntime: findsNone });

      await expect(ended).rejects.toBe(error);
    });
  });

  describe("when --help is given", () => {
    it("succeeds with the usage on stdout for --help", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, ["--help"], {
        startChild: startsNoChild,
      });

      expect({ code, printed: stdout.length > 0, stderr }).toStrictEqual({
        code: 0,
        printed: true,
        stderr: "",
      });
    });

    it("prints the usage beside an unknown flag, checking nothing else", async () => {
      const dir = workspace();
      const usage = (await command(dir, ["--help"])).stdout;

      const { code, stdout, stderr } = await command(dir, ["--banana", "--help"], {
        startChild: startsNoChild,
      });

      expect({ code, stdout, stderr }).toStrictEqual({ code: 0, stdout: usage, stderr: "" });
    });
  });

  describe("when --version is given", () => {
    it("prints the package's version on stdout for --version beside an unknown flag", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, ["--banana", "--version"], {
        startChild: startsNoChild,
      });

      expect({ code, version: stdout.includes(VERSION), stderr }).toStrictEqual({
        code: 0,
        version: true,
        stderr: "",
      });
    });

    it("prints the version, not the usage, beside --help", async () => {
      const dir = workspace();
      const version = (await command(dir, ["--version"])).stdout;

      const { code, stdout, stderr } = await command(dir, ["--version", "--help"], {
        startChild: startsNoChild,
      });

      expect({ code, stdout, stderr }).toStrictEqual({ code: 0, stdout: version, stderr: "" });
    });

    it("takes --version after a -- terminator as a benchmark file, exiting 2 naming it", async () => {
      const dir = workspace();

      const { code, stdout, stderr } = await command(dir, ["--", "--version"], {
        startChild: startsNoChild,
      });

      expect({ code, stdout, stderr }).toStrictEqual({
        code: 2,
        stdout: "",
        stderr: expect.stringContaining("--version"),
      });
    });
  });

  describe("when --list is given", () => {
    it("prints each selected case id, in selection order, running no case", async () => {
      const dir = workspace();

      const ended = await command(dir, ["--list", "sort.bench.ts", "parse.bench.ts"], {
        startChild: startsNoCase,
      });

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "sort/fast\nparse/fast\n",
      });
    });

    it("names a file under a subdirectory in its listing line by its slash-separated relative path", async () => {
      const dir = temporaryDir("repset-command-");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "sort.bench.ts"), "");

      const { stderr } = await command(dir, ["--list"]);

      expect(linesOf(stderr)).toContainEqual(
        expect.stringMatching(/(?:^|\s)sub\/sort\.bench\.ts$/u),
      );
    });
  });

  describe("when a run measures", () => {
    it("prints the table on stdout once, when the run ends", async () => {
      const dir = workspace();
      const stdout = captured();
      const printedDuringRun: string[] = [];
      const watchesStdout = starter((request, runtime, options) => {
        printedDuringRun.push(stdout.text);
        return measuresAll(runtime, request, options);
      });

      await command(dir, ["sort.bench.ts", "parse.bench.ts", "--out", "report.json"], {
        stdout,
        startChild: watchesStdout,
      });

      expect({ printedDuringRun, stdout: stdout.text }).toStrictEqual({
        printedDuringRun: ["", ""],
        stdout: formatTable(reportAt(join(dir, "report.json")).results),
      });
    });

    it("prints a progress line on stderr as each case's child starts, naming its runtime and case", async () => {
      const dir = workspace();

      const { stderr } = await command(dir, [
        "--runtime",
        "bun,node",
        "sort.bench.ts",
        "parse.bench.ts",
      ]);

      expect(linesOf(stderr)).toStrictEqual(
        expect.arrayContaining([
          naming("bun", "sort/fast"),
          naming("bun", "parse/fast"),
          naming("node", "sort/fast"),
          naming("node", "parse/fast"),
        ]),
      );
    });
  });

  describe("when REPSET_CALLS_PER_SAMPLE is set or unset", () => {
    const NAME = "REPSET_CALLS_PER_SAMPLE";
    const MAX = Number.MAX_SAFE_INTEGER;

    it.each([
      { why: "unset", value: undefined, asked: [undefined, undefined] },
      { why: "set to the largest safe integer", value: String(MAX), asked: [MAX, MAX] },
    ])("asks each measuring child of a run for its count when $why", async ({ value, asked }) => {
      vi.stubEnv(NAME, value);
      const counts: (number | undefined)[] = [];
      const keepsCount = starter((request, runtime, options) => {
        if (request.mode === "measure") counts.push(request.callsPerSample);
        return measuresAll(runtime, request, options);
      });

      const { code } = await command(workspace(), ["sort.bench.ts", "parse.bench.ts"], {
        startChild: keepsCount,
      });

      expect({ code, counts }).toStrictEqual({ code: 0, counts: asked });
    });

    it.each([
      { why: "zero", value: "0" },
      { why: "an exponent", value: "1e3" },
      { why: "a count past the safe integers", value: String(MAX + 1) },
    ])("exits 2 on $why, naming the value on stderr, with no child", async ({ value }) => {
      vi.stubEnv(NAME, value);

      const { code, stdout, stderr } = await command(workspace(), ["sort.bench.ts"], {
        startChild: startsNoChild,
      });

      expect({
        code,
        stdout,
        named: stderr.includes(JSON.stringify(value)),
      }).toStrictEqual({ code: 2, stdout: "", named: true });
    });

    it("runs --version as it does with REPSET_CALLS_PER_SAMPLE unset when the variable holds a bad value", async () => {
      const dir = workspace();
      vi.stubEnv(NAME, undefined);
      const unset = await command(dir, ["--version"]);
      vi.stubEnv(NAME, "abc");

      const ended = await command(dir, ["--version"], { startChild: startsNoChild });

      expect(ended).toStrictEqual(unset);
    });
  });

  describe("when --out names a file", () => {
    it("writes the report once listing passed and again after every result", async () => {
      const dir = workspace();
      const report = join(dir, "report.json");
      const writtenAtStart: number[] = [];
      const readsReport = starter((request, runtime, options) => {
        writtenAtStart.push(reportAt(report).results.length);
        return measuresAll(runtime, request, options);
      });

      await command(
        dir,
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--out", "report.json"],
        { startChild: readsReport },
      );

      expect({ writtenAtStart, atEnd: reportAt(report).results.length }).toStrictEqual({
        writtenAtStart: [0, 1, 2, 3],
        atEnd: 4,
      });
    });

    it("exits 2 with no case run, leaving no temporary file, when the first write fails", async () => {
      const dir = workspace();
      blockWrites(join(dir, "out/report.json"));

      const { code } = await command(dir, ["sort.bench.ts", "--out", "out/report.json"], {
        startChild: startsNoCase,
      });

      expect({ code, left: readdirSync(join(dir, "out")) }).toStrictEqual({
        code: 2,
        left: ["report.json"],
      });
    });

    it("keeps running past a failed write, saying nothing once a later write repairs it", async () => {
      const dir = workspace();
      const report = join(dir, "out/report.json");
      let started = 0;
      let writtenAtLastStart = 0;
      const failsOneWrite = starter((request, runtime, options) => {
        started += 1;
        if (started === 2) blockWrites(report);
        if (started === 3) unblockWrites(report);
        if (started === 4) writtenAtLastStart = reportAt(report).results.length;
        return measuresAll(runtime, request, options);
      });

      const { code, stderr } = await command(
        dir,
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--out", "out/report.json"],
        { startChild: failsOneWrite },
      );

      expect({
        code,
        writtenAtLastStart,
        results: reportAt(report).results.length,
        mentioned: stderr.includes("report.json"),
      }).toStrictEqual({
        code: 0,
        writtenAtLastStart: 3,
        results: 4,
        mentioned: false,
      });
    });

    it("exits 1 reporting a failed last write on stderr", async () => {
      const dir = workspace();
      const report = join(dir, "out/report.json");
      const blocksLastWrites = starter((request, runtime, options) => {
        if (request.id === "parse/fast") blockWrites(report);
        return measuresAll(runtime, request, options);
      });

      const { code, stderr } = await command(
        dir,
        ["sort.bench.ts", "parse.bench.ts", "--out", "out/report.json"],
        { startChild: blocksLastWrites },
      );

      expect({ code, mentioned: stderr.includes("report.json") }).toStrictEqual({
        code: 1,
        mentioned: true,
      });
    });
  });

  describe("when --out is -", () => {
    /** Runs two files with the report on stdout. */
    async function runToStdout(): Promise<Ended> {
      return command(workspace(), ["sort.bench.ts", "parse.bench.ts", "--out", "-"]);
    }

    it("prints the report on stdout, exiting 0", async () => {
      const { code, stdout } = await runToStdout();

      const { results } = parseReport(stdout, "stdout");
      expect({ code, results: results.length }).toStrictEqual({ code: 0, results: 2 });
    });

    it("prints the table on stderr", async () => {
      const { stdout, stderr } = await runToStdout();

      const { results } = parseReport(stdout, "stdout");
      expect(stderr.endsWith(formatTable(results))).toBe(true);
    });
  });

  describe("when --metric-lines is given", () => {
    /**
     * Runs two files with metric lines, the second case failing, recording stdout as each child
     * starts.
     */
    async function runWithMetricLines(): Promise<
      Ended & {
        readonly printedAtStart: readonly string[];
        readonly results: readonly Result[];
        readonly metricText: string;
      }
    > {
      const dir = workspace();
      const stdout = captured();
      const printedAtStart: string[] = [];
      const watchesStdout = starter((request, runtime, options) => {
        printedAtStart.push(stdout.text);
        return failsParse(runtime, request, options);
      });
      const { code, stderr } = await command(
        dir,
        ["sort.bench.ts", "parse.bench.ts", "--metric-lines", "--out", "report.json"],
        { stdout, startChild: watchesStdout },
      );
      const { results } = reportAt(join(dir, "report.json"));
      const metricText = results
        .map((result) => metricLine(result))
        .filter((line) => line !== undefined)
        .map((line) => `${line}\n`)
        .join("");
      return { code, stdout: stdout.text, stderr, printedAtStart, results, metricText };
    }

    it("prints each measured result's metric line on stdout, exiting 1 when a case failed", async () => {
      const ended = await runWithMetricLines();

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 1,
        stdout: ended.metricText,
      });
    });

    it("prints each metric line as its result finishes", async () => {
      const ended = await runWithMetricLines();

      expect(ended.printedAtStart).toStrictEqual(["", ended.metricText]);
    });

    it("prints the table on stderr", async () => {
      const ended = await runWithMetricLines();

      expect(ended.stderr.endsWith(formatTable(ended.results))).toBe(true);
    });
  });

  describe("when --once is given", () => {
    it("prints one line per case, naming a failure's phase and message, exiting 1", async () => {
      const dir = workspace();

      const { code, stdout } = await command(dir, ["--once", "sort.bench.ts", "parse.bench.ts"], {
        startChild: failsParse,
      });

      expect({ code, lines: linesOf(stdout) }).toStrictEqual({
        code: 1,
        lines: [naming("node", "sort/fast"), naming("node", "parse/fast", "fn", "kiwi")],
      });
    });

    it("exits 0 with an ok line per case when every case passes", async () => {
      const dir = workspace();

      const { code, stdout } = await command(dir, ["--once", "sort.bench.ts", "parse.bench.ts"]);

      expect({ code, lines: linesOf(stdout) }).toStrictEqual({
        code: 0,
        lines: [naming("ok", "node", "sort/fast"), naming("ok", "node", "parse/fast")],
      });
    });
  });

  describe("on a terminal stderr", () => {
    const TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;

    beforeEach(() => {
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", undefined);
      vi.stubEnv("TERM", "xterm-256color");
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    /** A stream stand-in for a terminal `columns` wide, with nothing written yet. */
    function terminalOf(
      columns: number,
    ): ReturnType<typeof terminal> & { readonly columns: number } {
      return Object.assign(terminal(), { columns });
    }

    /** The rows a terminal shows for `text`: a carriage return rewrites its row from the start. */
    function screen(text: string): string[] {
      return text
        .split("\n")
        .map((row) => stripVTControlCharacters(row.slice(row.lastIndexOf("\r") + 1)));
    }

    /** The row a terminal shows last for `text`: the live line while one is drawn. */
    function lastRow(text: string): string {
      return screen(text).at(-1) ?? "";
    }

    /** Wraps `start` to keep the rows `stderr` shows in `screens` as each child starts. */
    function watching(
      stderr: { readonly text: string },
      screens: string[][],
      start: StartChild,
    ): StartChild {
      return async (runtime, request, options) => {
        screens.push(screen(stderr.text));
        return start(runtime, request, options);
      };
    }

    /** A matcher for a row that contains `text`, ignoring the indicator frame before it. */
    const live = (text: string): unknown => expect.stringContaining(text);
    const listing = [[live("[1/2] listing sort.bench.ts")], [live("[2/2] listing parse.bench.ts")]];

    it.each([
      {
        run: "a measuring run",
        args: [],
        screens: [
          ...listing,
          [live("[1/2] measuring sort/fast on node")],
          [live("[2/2] measuring parse/fast on node")],
        ],
      },
      {
        run: "a --once run",
        args: ["--once"],
        screens: [
          ...listing,
          [live("[1/2] running sort/fast on node")],
          [live("[2/2] running parse/fast on node")],
        ],
      },
    ])(
      "shows one counted live line per child of $run, leaving nothing on stderr once it ends",
      async ({ args, screens }) => {
        const stderr = terminalOf(80);
        const seen: string[][] = [];

        await command(workspace(), [...args, "sort.bench.ts", "parse.bench.ts"], {
          stderr,
          startChild: watching(stderr, seen, failsParse),
        });

        expect({ seen, final: screen(stderr.text) }).toStrictEqual({ seen: screens, final: [""] });
      },
    );

    it("redraws the live line with the next indicator frame as time passes", async () => {
      vi.useFakeTimers({ toFake: [...TIMERS] });
      const stderr = terminalOf(80);
      const rows: string[] = [];
      const waits = starter(async (request, runtime, options) => {
        rows.push(lastRow(stderr.text));
        await vi.advanceTimersToNextTimerAsync();
        rows.push(lastRow(stderr.text));
        return measuresAll(runtime, request, options);
      });

      await command(workspace(), ["sort.bench.ts"], { stderr, startChild: waits });

      const line = live("[1/1] measuring sort/fast on node");
      expect({ moved: rows[0] !== rows[1], rows }).toStrictEqual({
        moved: true,
        rows: [line, line],
      });
    });

    it("cuts the live line to the terminal's width", async () => {
      const stderr = terminalOf(20);
      const seen: string[][] = [];

      await command(workspace(), ["sort.bench.ts", "parse.bench.ts"], {
        stderr,
        startChild: watching(stderr, seen, measuresAll),
      });

      const fits = seen.map((rows) => {
        const row = rows.at(-1) ?? "";
        return row.length > 0 && row.length < 20;
      });
      expect(fits).toStrictEqual([true, true, true, true]);
    });

    it("cuts a live line holding wide characters to the terminal's columns", async () => {
      const dir = workspace();
      const file = "水果水果水果水果水果.bench.ts";
      writeFileSync(join(dir, file), "");
      const stderr = terminalOf(20);
      const seen: string[][] = [];
      const lists = fakeStarter(
        () => ({ id: "fruit/fast", setupPerCall: false }),
        () => ranOnce,
      );

      await command(dir, ["--list", file], { stderr, startChild: watching(stderr, seen, lists) });

      const row = seen[0]?.at(-1) ?? "";
      // Each Han character is one UTF-16 unit drawn two columns wide.
      const columns = row.length + (row.match(/\p{Script=Han}/gu)?.length ?? 0);
      expect({ shown: row.includes("水"), fits: columns < 20 }).toStrictEqual({
        shown: true,
        fits: true,
      });
    });

    it("prints the lines a stderr that is not a terminal gets when TERM is dumb", async () => {
      const dir = workspace();
      const args = ["sort.bench.ts", "parse.bench.ts"];
      const plain = await command(dir, args, { startChild: failsParse, stderr: captured() });
      vi.stubEnv("TERM", "dumb");

      const dumb = await command(dir, args, { startChild: failsParse, stderr: terminalOf(80) });

      expect({ same: dumb.stderr === plain.stderr, lines: linesOf(dumb.stderr) }).toStrictEqual({
        same: true,
        lines: [
          "listing sort.bench.ts",
          "listing parse.bench.ts",
          "measuring sort/fast on node",
          "measuring parse/fast on node",
        ],
      });
    });

    it("clears the live line before printing the table under --out -", async () => {
      const stderr = terminalOf(80);

      const { stdout } = await command(
        workspace(),
        ["sort.bench.ts", "parse.bench.ts", "--out", "-"],
        { startChild: failsParse, stderr },
      );

      const { results } = parseReport(stdout, "stdout");
      expect(screen(stderr.text)).toStrictEqual(screen(formatTable(results)));
    });

    it("clears the live line before printing a failed listing's error", async () => {
      const stderr = terminalOf(80);
      const failsListing: StartChild = async () => failedOutcome("load", "kiwi");

      const { code } = await command(workspace(), ["sort.bench.ts"], {
        startChild: failsListing,
        stderr,
      });

      expect({ code, screen: screen(stderr.text) }).toStrictEqual({
        code: 2,
        screen: [expect.stringMatching(/^repset: .*sort\.bench\.ts.*load.*kiwi/u), ""],
      });
    });

    it("stops and clears the live line before rejecting with an error that is not a ConfigError", async () => {
      vi.useFakeTimers({ toFake: [...TIMERS] });
      const stderr = terminalOf(80);
      const error = new Error("kiwi");
      let tickingAtCrash = false;
      const crashes = starter(() => {
        tickingAtCrash = vi.getTimerCount() > 0;
        throw error;
      });

      const ended = command(workspace(), ["sort.bench.ts"], { stderr, startChild: crashes });

      await expect(ended).rejects.toBe(error);
      expect({
        tickingAtCrash,
        timersLeft: vi.getTimerCount(),
        last: lastRow(stderr.text),
      }).toStrictEqual({ tickingAtCrash: true, timersLeft: 0, last: "" });
    });

    it("clears the live line on SIGINT, exiting 130", async () => {
      const stderr = terminalOf(80);
      const signals = new EventEmitter();
      const stopsSecond = starter((request, runtime, options) => {
        if (request.id === "sort/fast") return measuresAll(runtime, request, options);
        signals.emit("SIGINT");
        return stopped;
      });

      const { code } = await command(workspace(), ["sort.bench.ts", "parse.bench.ts"], {
        signals,
        stderr,
        startChild: stopsSecond,
      });

      expect({ code, screen: screen(stderr.text) }).toStrictEqual({
        code: 130,
        screen: [""],
      });
    });
  });

  describe("on an interrupt", () => {
    it.each([
      { signal: "SIGINT", code: 130 },
      { signal: "SIGTERM", code: 143 },
      { signal: "SIGHUP", code: 129 },
    ])(
      "exits $code on $signal after a failed case, with the finished results in the report and table",
      async ({ signal, code }) => {
        const dir = workspace();
        const signals = new EventEmitter();
        const failsThenStops = starter((request) => {
          if (request.id === "sort/fast") return failedOutcome("fn", "kiwi");
          signals.emit(signal);
          return stopped;
        });

        const ended = await command(
          dir,
          ["sort.bench.ts", "parse.bench.ts", "--out", "report.json"],
          { signals, startChild: failsThenStops },
        );

        const report = reportAt(join(dir, "report.json"));
        expect({
          code: ended.code,
          interrupted: report.interrupted,
          ran: report.results.map((result) => result.id),
          stdout: ended.stdout,
        }).toStrictEqual({
          code,
          interrupted: true,
          ran: ["sort/fast"],
          stdout: formatTable(report.results),
        });
      },
    );

    it("exits 130 on SIGINT in a --list run, printing nothing on stdout", async () => {
      const dir = workspace();
      const signals = new EventEmitter();
      const stops: StartChild = async () => {
        signals.emit("SIGINT");
        return stopped;
      };

      const ended = await command(dir, ["--list", "sort.bench.ts"], { signals, startChild: stops });

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({ code: 130, stdout: "" });
    });

    it("exits 130, not 2, when a listing fails after SIGINT, still printing the failure", async () => {
      const dir = workspace();
      const signals = new EventEmitter();
      const failsListingAfterSignal: StartChild = async () => {
        signals.emit("SIGINT");
        return failedOutcome("load", "kiwi");
      };

      const ended = await command(dir, ["sort.bench.ts"], {
        signals,
        startChild: failsListingAfterSignal,
      });

      expect({ code: ended.code, last: linesOf(ended.stderr).at(-1) }).toStrictEqual({
        code: 130,
        last: naming("sort.bench.ts", "load", "kiwi"),
      });
    });
  });
});
