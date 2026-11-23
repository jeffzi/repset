import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { FoundRuntime, LookupOptions } from "../src/children.js";
import { ConfigError, type ResolvedOptions } from "../src/options.js";
import { selectCases, type SelectedCase, type Selection } from "../src/select.js";
import { expectConfigError } from "./helpers/config-error.js";
import {
  failedOutcome,
  findAny,
  found,
  type FindRuntime,
  listed,
  type Runtime,
  type StartChild,
  stopped,
} from "./helpers/fake-children.js";
import { fixturePath } from "./helpers/fixture-path.js";

/** The discovery fixtures the selection tests list. */
const FIXTURES = fixturePath("discovery");

/** The working directory the include-base tests run from, outside the discovery fixtures. */
const TESTS = fileURLToPath(new URL(".", import.meta.url));

/** The absolute path of the discovery fixture `name`. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

/** Resolved options for the discovery fixtures, with `overrides` applied. */
function optionsWith(overrides: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    include: ["**/*.bench.{ts,mts}"],
    includeBase: FIXTURES,
    runtimes: ["node"],
    minTime: 1000,
    minSampleCount: 64,
    debug: false,
    timeout: 600_000,
    nodeImport: undefined,
    filter: undefined,
    measure: ["time"],
    ...overrides,
  };
}

/** A child starter that lists, per file name, the case ids `byFile` gives; other files list none. */
function listing(byFile: Record<string, string[]>): StartChild {
  return async (_runtime, request) =>
    listed((byFile[basename(request.file)] ?? []).map((id) => ({ id, setupPerCall: false })));
}

/** A child starter that lists one case per file, named for the file. */
const onePerFile: StartChild = async (_runtime, request) =>
  listed([{ id: basename(request.file), setupPerCall: false }]);

/** A listing outcome that fails, which fails the selection if its child is started. */
const FAILED = failedOutcome("load", "kiwi");

/** A runtime lookup that finds node and is stopped while looking for bun. */
function stoppedOnBun(
  runtime: Runtime,
  options: LookupOptions & { readonly signal?: undefined },
): Promise<FoundRuntime>;
function stoppedOnBun(runtime: Runtime, options: LookupOptions): Promise<FoundRuntime | undefined>;
async function stoppedOnBun(runtime: Runtime): Promise<FoundRuntime | undefined> {
  return runtime === "bun" ? undefined : found(runtime);
}

/** Selects from the discovery fixtures, passing the stop signal on only when one is given. */
async function select(
  input: {
    options?: Partial<ResolvedOptions>;
    files?: string[];
    cwd?: string;
    signal?: AbortSignal;
    startChild?: StartChild;
    findRuntime?: FindRuntime;
    onPlanned?: (total: number) => void;
  } = {},
): Promise<Selection> {
  return selectCases({
    options: optionsWith(input.options),
    files: input.files ?? [],
    cwd: input.cwd ?? FIXTURES,
    findRuntime: input.findRuntime ?? findAny,
    startChild: input.startChild ?? onePerFile,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onPlanned === undefined ? {} : { onPlanned: input.onPlanned }),
  });
}

/** The selected cases, failing the test when the selection stopped. */
function casesOf(selection: Selection): readonly SelectedCase[] {
  if (selection.status !== "selected") throw new Error("the selection stopped");
  return selection.cases;
}

/** The absolute file of each selected case, failing the test when the selection stopped. */
function pathsOf(selection: Selection): string[] {
  return casesOf(selection).map((selected) => selected.path);
}

/** The id of each selected case, failing the test when the selection stopped. */
function idsOf(selection: Selection): string[] {
  return casesOf(selection).map((selected) => selected.id);
}

describe("selectCases", () => {
  describe("when a plan callback is given", () => {
    it("receives the number of files to list before the first listing child starts", async () => {
      const events: string[] = [];

      await select({
        files: ["zeta.bench.ts", "a.bench.ts", "alpha.bench.mts"],
        startChild: async (runtime, request, options) => {
          events.push(request.mode);
          return onePerFile(runtime, request, options);
        },
        onPlanned: (total) => {
          events.push(`planned ${total}`);
        },
      });

      expect(events).toStrictEqual(["planned 3", "list", "list", "list"]);
    });
  });

  describe("when no positional file is given", () => {
    it("matches the include globs against includeBase, not cwd", async () => {
      const selection = await select({ cwd: TESTS });

      const paths = pathsOf(selection);
      expect({
        found: paths.length > 0,
        outsideBase: paths.filter((path) => !path.startsWith(FIXTURES + sep)),
      }).toStrictEqual({ found: true, outsideBase: [] });
    });

    it("skips every file under a node_modules directory", async () => {
      const selection = await select({ cwd: TESTS });

      const paths = pathsOf(selection);
      expect({
        found: paths.length > 0,
        underNodeModules: paths.filter((path) => path.split(sep).includes("node_modules")),
      }).toStrictEqual({ found: true, underNodeModules: [] });
    });

    it("sorts the files by slash-separated path, putting nested/ before nested2", async () => {
      const selection = await select({ cwd: TESTS });

      expect(pathsOf(selection).filter((path) => path.includes("nested"))).toStrictEqual([
        fixture("nested/deep/inner.bench.ts"),
        fixture("nested/mid.bench.ts"),
        fixture("nested2.bench.ts"),
      ]);
    });
  });

  describe("when positional files are given", () => {
    it("takes an argument naming an existing file whose name holds glob characters as that file", async () => {
      const selection = await select({ files: ["[ab].bench.ts"] });

      expect(pathsOf(selection)).toStrictEqual([fixture("[ab].bench.ts")]);
    });

    it.each([
      { why: "no file", file: "banana.bench.ts" },
      { why: "a directory", file: "nested" },
    ])("rejects an argument that matches $why, naming it", async ({ file }) => {
      const result = select({ files: ["zeta.bench.ts", file] });

      await expectConfigError(result, [file]);
    });

    it("lists the files in the order the arguments are written", async () => {
      const files = ["zeta.bench.ts", "nested/**/*.bench.ts", "alpha.bench.mts"];

      const selection = await select({ files });

      expect(pathsOf(selection)).toStrictEqual([
        fixture("zeta.bench.ts"),
        fixture("nested/deep/inner.bench.ts"),
        fixture("nested/mid.bench.ts"),
        fixture("alpha.bench.mts"),
      ]);
    });

    it("keeps a file matched twice once, at its first place", async () => {
      const files = ["zeta.bench.ts", "*.bench.ts"];

      const selection = await select({ files });

      expect(pathsOf(selection)).toStrictEqual([
        fixture("zeta.bench.ts"),
        fixture("[ab].bench.ts"),
        fixture("a.bench.ts"),
        fixture("nested2.bench.ts"),
      ]);
    });
  });

  describe("when several runtimes are selected", () => {
    it("lists each file on the first selected runtime", async () => {
      const byRuntime: StartChild = async (runtime) =>
        listed([{ id: runtime.runtime, setupPerCall: false }]);

      const selection = await select({
        options: { runtimes: ["bun", "node"] },
        files: ["zeta.bench.ts"],
        startChild: byRuntime,
      });

      expect(idsOf(selection)).toStrictEqual(["bun"]);
    });
  });

  describe("when a listing child fails", () => {
    it("rejects the file when its child answers with a failure", async () => {
      const error = {
        phase: "load",
        message: "kiwi",
        stack: "at load",
        teardownError: null,
      } as const;
      const failing: StartChild = async () => ({ status: "failed", error, output: "plum\n" });

      const result = select({ files: ["zeta.bench.ts"], startChild: failing });

      await expectConfigError(result, ["zeta.bench.ts", error.phase, error.message]);
      await expect(result).rejects.toMatchObject({ failureStack: error.stack, output: "plum\n" });
    });
  });

  describe("when cases share an id", () => {
    it("rejects them, naming the first repeated id and every file that registers it in listing order", async () => {
      const result = select({
        files: ["zeta.bench.ts", "nested2.bench.ts", "alpha.bench.mts"],
        startChild: listing({
          "zeta.bench.ts": ["banana", "apple"],
          "nested2.bench.ts": ["apple"],
          "alpha.bench.mts": ["apple", "banana"],
        }),
      });

      await expectConfigError(result, [
        /\bapple\b.*\bzeta\.bench\.ts\b.*\bnested2\.bench\.ts\b.*\balpha\.bench\.mts\b/u,
      ]);
    });
  });

  describe("with a filter", () => {
    it("keeps every case whose id it matches anywhere, in listing order", async () => {
      const startChild = listing({ "zeta.bench.ts": ["apple pie", "banana", "pineapple"] });

      const selection = await select({
        options: { filter: /apple/u },
        files: ["zeta.bench.ts"],
        startChild,
      });

      expect(idsOf(selection)).toStrictEqual(["apple pie", "pineapple"]);
    });
  });

  describe("when nothing is selected", () => {
    it.each([
      {
        why: "no file matched include",
        options: { include: ["**/*.banana"] },
        named: ["**/*.banana"],
      },
      {
        why: "the filter matches no case",
        options: { filter: /banana/u },
        named: ["/banana/u"],
      },
    ])(
      "rejects the selection when $why, naming what matched nothing",
      async ({ options, named }) => {
        const result = select({ options });

        await expectConfigError(result, named);
      },
    );

    it("rejects the selection when no file registers a case, before any filter is applied", async () => {
      const result = select({ startChild: listing({}) });

      await expect(result).rejects.toBeInstanceOf(ConfigError);
      await expect(result).rejects.not.toThrow(/filter/u);
    });
  });

  describe("when files are given relative to cwd on two runtimes", () => {
    it("holds the runtimes with their versions and each case's id, files and setupPerCall", async () => {
      const startChild: StartChild = async (_runtime, request) =>
        listed([
          { id: basename(request.file), setupPerCall: request.file.endsWith("inner.bench.ts") },
        ]);

      const selection = await select({
        options: { runtimes: ["node", "bun"] },
        files: ["../a.bench.ts", "deep/inner.bench.ts"],
        cwd: fixture("nested"),
        startChild,
      });

      expect(selection).toStrictEqual({
        status: "selected",
        runtimes: [found("node"), found("bun")],
        cases: [
          {
            id: "a.bench.ts",
            name: "a.bench.ts",
            contender: null,
            path: fixture("a.bench.ts"),
            file: "../a.bench.ts",
            setupPerCall: false,
          },
          {
            id: "inner.bench.ts",
            name: "inner.bench.ts",
            contender: null,
            path: fixture("nested/deep/inner.bench.ts"),
            file: "deep/inner.bench.ts",
            setupPerCall: true,
          },
        ],
      });
    });
  });

  describe("when the stop signal fires during listing", () => {
    it("ends as stopped when the running listing child was stopped", async () => {
      const controller = new AbortController();
      const stopping: StartChild = async (_runtime, request) => {
        if (basename(request.file) === "zeta.bench.ts") return FAILED;
        controller.abort();
        return stopped;
      };

      const selection = await select({
        files: ["a.bench.ts", "zeta.bench.ts"],
        signal: controller.signal,
        startChild: stopping,
      });

      expect(selection).toStrictEqual({ status: "stopped" });
    });

    it("starts no further child once a listing child finished", async () => {
      const controller = new AbortController();
      const stopAfterFirst: StartChild = async (_runtime, request) => {
        if (basename(request.file) === "zeta.bench.ts") return FAILED;
        controller.abort();
        return listed([{ id: "apple", setupPerCall: false }]);
      };

      const selection = await select({
        files: ["a.bench.ts", "zeta.bench.ts"],
        signal: controller.signal,
        startChild: stopAfterFirst,
      });

      expect(selection).toStrictEqual({ status: "stopped" });
    });
  });

  describe("when a runtime lookup was stopped", () => {
    it("ends as stopped", async () => {
      const selection = await select({
        options: { runtimes: ["node", "bun"] },
        findRuntime: stoppedOnBun,
      });

      expect(selection).toStrictEqual({ status: "stopped" });
    });
  });
});
