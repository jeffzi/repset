import { EventEmitter } from "node:events";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatTable } from "../src/table.js";
import {
  blockWrites,
  captured,
  closed,
  closedHeld,
  command,
  failsParse,
  linesOf,
  measuresAll,
  naming,
  runToStdout,
  runWithReport,
  starter,
  startsNoCase,
  stubColorTerminalEnv,
  terminal,
  unblockWrites,
  workspace,
} from "./command-harness.js";
import {
  APPLE,
  contender,
  failedOutcome,
  listingStarter,
  measuredOutcome,
  ranOnce,
  starter as fakeStarter,
  type StartChild,
  startsNoChild,
  stopped,
} from "./fake-children.js";
import { reportAt } from "./report-file.js";

/** A child starter that ends as stopped once the run is aborted, and measures every case before. */
const measuresUnlessAborted: StartChild = async (runtime, request, options) =>
  options.signal?.aborted === true ? stopped : measuresAll(runtime, request, options);

describe("main", () => {
  beforeEach(() => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("REPSET_CALLS_PER_SAMPLE", undefined);
  });

  describe("when files and every run option are given", () => {
    it("hands the positional files, --runtime, --filter, --min-time, --min-samples, --timeout, --node-import and --output to the run", async () => {
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
        "--output",
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

  describe("when the command line is wrong", () => {
    it.each([
      { why: "an empty number", args: ["--min-time", ""], named: ["min-time"] },
      { why: "--list with --once", args: ["--list", "--once"], named: ["list", "once"] },
      {
        why: "a --timeout that is not decimal",
        args: ["--timeout", "1e3"],
        named: ["timeout", "1e3"],
      },
      {
        why: "an unknown --runtime name",
        args: ["--runtime", "node,banana"],
        named: ["node,banana"],
      },
    ])(
      "exits 2 on $why, naming it on stderr, with nothing on stdout and no child",
      async ({ args, named }) => {
        const dir = workspace();

        const { code, stdout, stderr } = await command(dir, args, { startChild: startsNoChild });

        expect({ code, stdout, stderr }).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: naming(...named),
        });
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

    it("lists the cases of the files the include globs find when no file is given", async () => {
      const dir = workspace();

      const ended = await command(dir, ["--list"], { startChild: startsNoCase });

      expect({ code: ended.code, stdout: ended.stdout }).toStrictEqual({
        code: 0,
        stdout: "parse/fast\nsort/fast\n",
      });
    });
  });

  describe("when a run measures", () => {
    it("prints the table on stdout once, when the run ends", async () => {
      const stdout = captured();
      const printedDuringRun: string[] = [];
      const watchesStdout = starter((request, runtime, options) => {
        printedDuringRun.push(stdout.text);
        return measuresAll(runtime, request, options);
      });

      const { report } = await runWithReport([], { stdout, startChild: watchesStdout });

      expect({ printedDuringRun, stdout: stdout.text }).toStrictEqual({
        printedDuringRun: ["", ""],
        stdout: formatTable(report.results, report.contests, { color: false }),
      });
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

      expect({ code, stdout, stderr }).toStrictEqual({
        code: 2,
        stdout: "",
        stderr: naming(NAME, value),
      });
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

  describe("when --output names a file", () => {
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
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--output", "report.json"],
        { startChild: readsReport },
      );

      expect({ writtenAtStart, atEnd: reportAt(report).results.length }).toStrictEqual({
        writtenAtStart: [0, 1, 2, 3],
        atEnd: 4,
      });
    });

    it("holds a contest's entry once its last result is written", async () => {
      const dir = workspace();
      const report = join(dir, "report.json");
      const written: number[][] = [];
      const readsReport = listingStarter(
        [contender("join"), contender("loop"), APPLE],
        (request) => {
          if (request.id === APPLE.id) {
            const { results, contests } = reportAt(report);
            written.push([results.length, contests.length]);
          }
          return measuredOutcome(4656);
        },
      );

      await command(dir, ["sort.bench.ts", "--rounds", "2", "--output", "report.json"], {
        startChild: readsReport,
      });

      expect(written).toStrictEqual([[2, 1]]);
    });

    it("exits 2 with no case run, leaving no temporary file, when the first write fails", async () => {
      const dir = workspace();
      blockWrites(join(dir, "out/report.json"));

      const { code } = await command(dir, ["sort.bench.ts", "--output", "out/report.json"], {
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
        ["--runtime", "node,bun", "sort.bench.ts", "parse.bench.ts", "--output", "out/report.json"],
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
        ["sort.bench.ts", "parse.bench.ts", "--output", "out/report.json"],
        { startChild: blocksLastWrites },
      );

      expect({ code, mentioned: stderr.includes("report.json") }).toStrictEqual({
        code: 1,
        mentioned: true,
      });
    });
  });

  describe("when --output is -", () => {
    it("prints the report on stdout, exiting 0", async () => {
      const { code, results } = await runToStdout();

      expect({ code, results: results.length }).toStrictEqual({ code: 0, results: 2 });
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
      stubColorTerminalEnv();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A terminal stream stand-in that reports its width. */
    interface SizedTerminal extends ReturnType<typeof terminal> {
      readonly columns: number;
    }

    /** A stream stand-in for a terminal `columns` wide, with nothing written yet. */
    function terminalOf(columns: number): SizedTerminal {
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

    it("lowers the live line's total by the rounds a failed contender will not run, keeping its started count", async () => {
      const stderr = terminalOf(80);
      const seen: string[][] = [];
      let loopCalls = 0;
      const failsLoopInRoundTwo = listingStarter(
        [contender("join"), contender("loop"), contender("plus")],
        (request) => {
          if (request.id !== "concat/loop") return measuredOutcome(4656);
          loopCalls += 1;
          return loopCalls === 2 ? failedOutcome("fn", "kiwi") : measuredOutcome(17);
        },
      );

      await command(workspace(), ["--rounds", "4", "sort.bench.ts"], {
        stderr,
        startChild: watching(stderr, seen, failsLoopInRoundTwo),
      });

      const counts = seen.slice(1).map((rows) =>
        /\[(\d+)\/(\d+)\]/u
          .exec(rows.at(-1) ?? "")
          ?.slice(1)
          .map(Number),
      );
      expect({
        started: counts.map((count) => count?.[0]),
        first: counts.at(0)?.[1],
        last: counts.at(-1)?.[1],
      }).toStrictEqual({
        started: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        first: 12,
        last: 10,
      });
    });

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

    it("clears the live line before printing the table under --output -", async () => {
      const stderr = terminalOf(80);

      const { results } = await runToStdout({ startChild: failsParse, stderr });

      expect(screen(stderr.text)).toStrictEqual(screen(formatTable(results, [], { color: false })));
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
  });

  describe("on an interrupt", () => {
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
  });

  describe("when a write to stdout fails", () => {
    it.each([
      { code: "EPIPE", exit: 141, said: [] },
      { code: "EIO", exit: 1, said: [expect.stringMatching(/^repset: .*\bEIO\b/u)] },
    ])(
      "on $code kills the running case, starts no other, keeps the report file and exits $exit",
      async ({ code, exit, said }) => {
        const dir = workspace();
        writeFileSync(join(dir, "pear.bench.ts"), "");
        const stdout = captured();
        const started: string[] = [];
        const failsStdoutInParse = starter((request, runtime, options) => {
          started.push(request.id);
          if (request.id === "parse/fast") stdout.fail(code);
          return measuresUnlessAborted(runtime, request, options);
        });

        const ended = await command(
          dir,
          ["sort.bench.ts", "parse.bench.ts", "pear.bench.ts", "--output", "report.json"],
          { stdout, startChild: failsStdoutInParse },
        );

        const report = reportAt(join(dir, "report.json"));
        expect({
          code: ended.code,
          started,
          ran: report.results.map((result) => result.id),
          interrupted: report.interrupted,
          stdout: ended.stdout,
          said: linesOf(ended.stderr).filter((line) => line.includes(code)),
        }).toStrictEqual({
          code: exit,
          started: ["sort/fast", "parse/fast"],
          ran: ["sort/fast"],
          interrupted: true,
          stdout: "",
          said,
        });
      },
    );

    it("exits 141 with interrupted false when the closed stdout only met the table, the last write", async () => {
      const { code, report } = await runWithReport([], { stdout: closed("EPIPE") });

      expect({
        code,
        interrupted: report.interrupted,
        ran: report.results.length,
      }).toStrictEqual({ code: 141, interrupted: false, ran: 2 });
    });

    it.each([
      { first: "SIGTERM", second: "EPIPE", exit: 143 },
      { first: "EPIPE", second: "SIGINT", exit: 141 },
    ])("exits $exit when $first comes before $second", async ({ first, second, exit }) => {
      const signals = new EventEmitter();
      const stdout = captured();
      const deliver = (event: string): void => {
        if (event.startsWith("SIG")) signals.emit(event);
        else stdout.fail(event);
      };
      const stopsTwice = starter(() => {
        deliver(first);
        deliver(second);
        return stopped;
      });

      const { code } = await command(workspace(), ["sort.bench.ts", "parse.bench.ts"], {
        signals,
        stdout,
        startChild: stopsTwice,
      });

      expect(code).toBe(exit);
    });

    it("names the error's message on stderr when it carries no code", async () => {
      const stdout = captured();
      const failsStdout = starter((request, runtime, options) => {
        stdout.fail(new Error("banana"));
        return measuresUnlessAborted(runtime, request, options);
      });

      const { code, stderr } = await command(workspace(), ["sort.bench.ts"], {
        stdout,
        startChild: failsStdout,
      });

      expect({
        code,
        said: linesOf(stderr).filter((line) => line.includes("banana")),
      }).toStrictEqual({
        code: 1,
        said: [expect.stringMatching(/^repset: .*\bbanana\b/u)],
      });
    });

    it("keeps listening for stdout's error once a write failed, so its late error event does not crash", async () => {
      const stdout = closedHeld("EPIPE");

      await command(workspace(), ["sort.bench.ts"], { stdout });

      expect(() => {
        stdout.emitHeld();
      }).not.toThrow();
    });
  });
});
