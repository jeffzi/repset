import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Outcome } from "../src/children.js";
import { ConfigError, type ResolvedOptions } from "../src/options.js";
import { selectCases, type SelectedCase, type Selection } from "../src/run.js";
import { expectConfigError } from "./config-error.js";
import { findAny, found, type FindRuntime, type StartChild } from "./fake-children.js";

const FIXTURES = fileURLToPath(new URL("fixtures/discovery", import.meta.url));

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
    minSamples: 64,
    timeout: 600_000,
    nodeImport: undefined,
    filter: undefined,
    ...overrides,
  };
}

/** A listing outcome holding `cases`. */
function listed(cases: { id: string; setupPerCall: boolean }[]): Outcome {
  return { status: "ok", result: { status: "ok", cases }, output: "" };
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
const FAILED: Outcome = {
  status: "failed",
  error: { phase: "load", message: "kiwi", stack: null, teardownError: null },
  output: "",
};

/** Selects from the discovery fixtures, with the working directory `cwd` and no stop signal. */
async function select(
  input: {
    options?: Partial<ResolvedOptions>;
    files?: string[];
    cwd?: string;
    signal?: AbortSignal;
    startChild?: StartChild;
    findRuntime?: FindRuntime;
  } = {},
): Promise<Selection> {
  return selectCases({
    options: optionsWith(input.options),
    files: input.files ?? [],
    cwd: input.cwd ?? FIXTURES,
    findRuntime: input.findRuntime ?? findAny,
    startChild: input.startChild ?? onePerFile,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
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
  describe("when no positional file is given", () => {
    it("matches the include globs against includeBase, ** and brace sets included, sorted by path", async () => {
      const selection = await select({ cwd: TESTS });

      expect(pathsOf(selection)).toStrictEqual([
        fixture("[ab].bench.ts"),
        fixture("a.bench.ts"),
        fixture("alpha.bench.mts"),
        fixture("nested/deep/inner.bench.ts"),
        fixture("nested/mid.bench.ts"),
        fixture("nested2.bench.ts"),
        fixture("zeta.bench.ts"),
      ]);
    });
  });

  describe("when positional files are given", () => {
    it("replaces include with the arguments, relative to the working directory", async () => {
      const options = { includeBase: TESTS };

      const selection = await select({ options, files: ["zeta.bench.ts"] });

      expect(pathsOf(selection)).toStrictEqual([fixture("zeta.bench.ts")]);
    });

    it.each([
      { why: "whose name holds glob characters", file: "[ab].bench.ts" },
      { why: "inside node_modules", file: "node_modules/pkg/hidden.bench.ts" },
    ])("takes an argument naming an existing file $why as that file", async ({ file }) => {
      const selection = await select({ files: [file] });

      expect(pathsOf(selection)).toStrictEqual([fixture(file)]);
    });

    it.each([
      { why: "no file", file: "banana.bench.ts" },
      { why: "a directory", file: "nested" },
    ])("rejects an argument that matches $why, naming it", async ({ file }) => {
      const result = select({ files: ["zeta.bench.ts", file] });

      await expectConfigError(result, [file]);
    });
  });

  describe("the order of files", () => {
    it("follows the order the arguments are written", async () => {
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

  describe("the runtimes", () => {
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

    it("rejects the file when its child answers a list request with no listing", async () => {
      const ranOnly: StartChild = async () => ({
        status: "ok",
        result: { status: "ok" },
        output: "plum\n",
      });

      const result = select({ files: ["zeta.bench.ts"], startChild: ranOnly });

      await expectConfigError(result, ["zeta.bench.ts"]);
      await expect(result).rejects.toMatchObject({ output: "plum\n" });
    });
  });

  describe("when two cases share an id", () => {
    it("rejects them, naming the id and the files", async () => {
      const result = select({
        files: ["zeta.bench.ts", "a.bench.ts"],
        startChild: listing({ "zeta.bench.ts": ["apple"], "a.bench.ts": ["apple"] }),
      });

      await expectConfigError(result, ["apple", "zeta.bench.ts", "a.bench.ts"]);
    });
  });

  describe("with a filter", () => {
    it("keeps only the cases whose id it matches anywhere, in their order", async () => {
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
        startChild: onePerFile,
        named: ["**/*.banana"],
      },
      {
        why: "the filter matches no case",
        options: { filter: /banana/u },
        startChild: onePerFile,
        named: ["/banana/u"],
      },
    ])(
      "rejects the selection when $why, naming what matched nothing",
      async ({ options, startChild, named }) => {
        const result = select({ options, startChild });

        await expectConfigError(result, named);
      },
    );

    it("rejects the selection when no file registers a case, before any filter is applied", async () => {
      const result = select({ startChild: listing({}) });

      await expect(result).rejects.toBeInstanceOf(ConfigError);
      await expect(result).rejects.not.toThrow(/filter/u);
    });
  });

  describe("the selection", () => {
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
            path: fixture("a.bench.ts"),
            file: "../a.bench.ts",
            setupPerCall: false,
          },
          {
            id: "inner.bench.ts",
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
        return { status: "stopped", output: "" };
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
});
