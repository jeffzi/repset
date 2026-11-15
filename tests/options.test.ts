import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ConfigError, resolveOptions, type OptionsInput } from "../src/options.js";
import { suiteTemporaryDir } from "./temporary-dir.js";

const FIXTURES = fileURLToPath(new URL("fixtures/config", import.meta.url));

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const OPTIONS_MODULE = new URL("../src/options.ts", import.meta.url).href;

/** Node and tsx starting on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * Resolves `config` from the fixture directory in a spawned Node process, where the import runs
 * through Node's own loader rather than Vitest's module runner, and returns its `minSamples`.
 */
function minSamplesInNode(config: string): string {
  const script = [
    `const { resolveOptions } = await import(${JSON.stringify(OPTIONS_MODULE)});`,
    `const resolved = await resolveOptions({ cwd: ${JSON.stringify(FIXTURES)}, config: ${JSON.stringify(config)} });`,
    "process.stdout.write(String(resolved.minSamples));",
  ].join("\n");
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

/** The absolute path of the config fixture `name`. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

/** Resolves `options` from the fixture directory, which holds no `repset.config.*` file. */
async function resolveHere(options: Partial<OptionsInput> = {}): ReturnType<typeof resolveOptions> {
  return resolveOptions({ cwd: FIXTURES, ...options });
}

/** Asserts that `result` rejects with a `ConfigError` whose message holds each of `named`. */
async function expectConfigError(
  result: Promise<unknown>,
  named: readonly string[],
): Promise<void> {
  await expect(result).rejects.toBeInstanceOf(ConfigError);
  for (const text of named) await expect(result).rejects.toThrow(text);
}

const DEFAULTS = {
  include: ["**/*.bench.{ts,mts,js,mjs}"],
  includeBase: FIXTURES,
  runtimes: ["node"],
  minTime: 1000,
  minSamples: 64,
  timeout: 600_000,
  nodeImport: undefined,
  filter: undefined,
};

describe("resolveOptions", () => {
  describe("when no config is named", () => {
    it("gives the defaults when the working directory holds no config file", async () => {
      const resolved = await resolveHere();

      expect(resolved).toStrictEqual(DEFAULTS);
    });

    it("reads the one config file the working directory holds", async () => {
      const resolved = await resolveOptions({ cwd: fixture("found") });

      expect(resolved.minSamples).toBe(3);
    });

    it("rejects a working directory that holds several config files, naming them", async () => {
      const result = resolveOptions({ cwd: fixture("several") });

      await expectConfigError(result, ["repset.config.ts", "repset.config.mts"]);
    });
  });

  describe("when a config is named", () => {
    it("reads it relative to the working directory", async () => {
      const resolved = await resolveHere({ config: "named.ts" });

      expect(resolved.minSamples).toBe(5);
    });

    it.each([{ path: "missing.ts" }, { path: "nested" }])(
      "rejects $path, which holds no file, naming it",
      async ({ path }) => {
        const result = resolveHere({ config: path });

        await expectConfigError(result, [path]);
      },
    );

    it("reads a file whose path a raw import would misread", { timeout: SPAWN_TIMEOUT_MS }, () => {
      const minSamples = minSamplesInNode("hash#name.ts");

      expect(minSamples).toBe("6");
    });
  });

  describe("when config is false", () => {
    it("reads no config file even when the working directory holds one", async () => {
      const resolved = await resolveOptions({ cwd: fixture("found"), config: false });

      expect(resolved.minSamples).toBe(DEFAULTS.minSamples);
    });
  });

  describe("when the config file cannot be imported", () => {
    const broken = suiteTemporaryDir("repset-config-");

    beforeAll(() => {
      writeFileSync(join(broken.path, "syntax-error.ts"), "export default {\n");
      writeFileSync(
        join(broken.path, "unresolved.ts"),
        'import "./nowhere.js";\nexport default {};\n',
      );
    });

    it("rejects a top-level throw, naming the file and carrying its message", async () => {
      const result = resolveHere({ config: "top-level-throw.ts" });

      await expectConfigError(result, ["top-level-throw.ts", "banana"]);
    });

    it.each([{ name: "syntax-error.ts" }, { name: "unresolved.ts" }])(
      "rejects $name, naming the file",
      async ({ name }) => {
        const result = resolveOptions({ cwd: broken.path, config: name });

        await expectConfigError(result, [name]);
      },
    );
  });

  describe("when the default export is not a plain object", () => {
    it.each([
      { name: "no-default.ts" },
      { name: "default-array.ts" },
      { name: "default-function.ts" },
      { name: "default-promise.ts" },
    ])("rejects $name, naming the file", async ({ name }) => {
      const result = resolveHere({ config: name });

      await expectConfigError(result, [name]);
    });
  });

  describe("when checking keys", () => {
    it("rejects a key that is not an option, naming it", async () => {
      const result = resolveHere({ config: "unknown-key.ts" });

      await expectConfigError(result, ["banana"]);
    });

    it("treats a config key holding undefined as absent", async () => {
      const resolved = await resolveHere({ config: "undefined-key.ts" });

      expect(resolved.minTime).toBe(DEFAULTS.minTime);
    });

    it("treats a key that is not an option and holds undefined as absent", async () => {
      const resolved = await resolveHere({ config: "unknown-undefined.ts" });

      expect(resolved).toStrictEqual({ ...DEFAULTS, includeBase: FIXTURES });
    });

    it("rejects a default export whose getter throws, naming the file and carrying its message", async () => {
      const result = resolveHere({ config: "getter-throws.ts" });

      await expectConfigError(result, ["getter-throws.ts", "pear"]);
    });

    it("rejects a config path the file system cannot stat", async () => {
      const result = resolveHere({ config: "apple\0.ts" });

      await expect(result).rejects.toBeInstanceOf(ConfigError);
    });

    it("accepts a timeout of 1", async () => {
      const resolved = await resolveHere({ timeout: 1 });

      expect(resolved.timeout).toBe(1);
    });

    it("treats a caller option holding undefined as absent", async () => {
      const resolved = await resolveHere({ config: "caller-undefined.ts", minTime: undefined });

      expect(resolved.minTime).toBe(5);
    });
  });

  describe("when the config file gives a bad value", () => {
    it.each([
      { name: "include-string.ts", option: "include", shown: "*.bench.ts" },
      { name: "include-number.ts", option: "include", shown: "7" },
      { name: "runtime-unknown.ts", option: "runtimes", shown: "deno" },
      { name: "node-import-number.ts", option: "nodeImport", shown: "5" },
    ])("rejects $name, naming $option and the value", async ({ name, option, shown }) => {
      const result = resolveHere({ config: name });

      await expectConfigError(result, [option, shown]);
    });
  });

  describe("when the caller gives a bad value", () => {
    it.each<{ options: Partial<OptionsInput>; option: string; shown: string }>([
      { options: { runtimes: [] }, option: "runtimes", shown: "[]" },
      { options: { runtimes: ["node", "bun", "node"] }, option: "runtimes", shown: "node" },
      { options: { minTime: -1 }, option: "minTime", shown: "-1" },
      { options: { minTime: Number.NaN }, option: "minTime", shown: "NaN" },
      { options: { minTime: Number.POSITIVE_INFINITY }, option: "minTime", shown: "Infinity" },
      { options: { minSamples: 0 }, option: "minSamples", shown: "0" },
      { options: { minSamples: 1.5 }, option: "minSamples", shown: "1.5" },
      { options: { timeout: 0 }, option: "timeout", shown: "0" },
      { options: { timeout: 2.5 }, option: "timeout", shown: "2.5" },
      { options: { timeout: 2_147_483_648 }, option: "timeout", shown: "2147483648" },
      { options: { filter: "(" }, option: "filter", shown: "(" },
      { options: { filter: String.raw`\-` }, option: "filter", shown: String.raw`\-` },
    ])(
      "rejects $option $shown, naming the option and the value",
      async ({ options, option, shown }) => {
        const result = resolveHere(options);

        await expectConfigError(result, [option, shown]);
      },
    );
  });

  describe("when merging", () => {
    it("takes every option the config file gives over the default", async () => {
      const resolved = await resolveHere({ config: "all-options.ts" });

      expect(resolved).toStrictEqual({
        include: ["bench/*.ts"],
        includeBase: FIXTURES,
        runtimes: ["bun", "node"],
        minTime: 0,
        minSamples: 1,
        timeout: 2_147_483_647,
        nodeImport: { written: "tsx", resolved: "tsx" },
        filter: undefined,
      });
    });

    it("takes every option the caller gives over the config file's", async () => {
      const resolved = await resolveHere({
        config: "caller-wins.ts",
        include: ["*.bench.mjs"],
        runtimes: ["node"],
        minTime: 7,
        minSamples: 9,
        timeout: 200,
        nodeImport: "jiti",
        filter: "^a",
      });

      expect(resolved).toStrictEqual({
        include: ["*.bench.mjs"],
        includeBase: FIXTURES,
        runtimes: ["node"],
        minTime: 7,
        minSamples: 9,
        timeout: 200,
        nodeImport: { written: "jiti", resolved: "jiti" },
        filter: /^a/u,
      });
    });

    it("compiles the filter with the u flag", async () => {
      const resolved = await resolveHere({ filter: String.raw`^\p{Lu}` });

      expect(resolved.filter?.test("Élan")).toBe(true);
    });
  });

  describe("when resolving bases", () => {
    it("bases include on the config file's directory", async () => {
      const resolved = await resolveHere({ config: "nested/include.ts" });

      expect(resolved.includeBase).toBe(fixture("nested"));
    });

    it.each([
      {
        name: "nested/dot-import.ts",
        written: "./loader.mjs",
        resolved: fixture("nested/loader.mjs"),
      },
      {
        name: "nested/parent-import.ts",
        written: "../loader.mjs",
        resolved: fixture("loader.mjs"),
      },
    ])(
      "resolves the config file's $written against its directory, keeping it as written",
      async ({ name, written, resolved }) => {
        const options = await resolveHere({ config: name });

        expect(options.nodeImport).toStrictEqual({ written, resolved });
      },
    );

    it("passes a relative nodeImport from the caller as written", async () => {
      const resolved = await resolveHere({ nodeImport: "./loader.mjs" });

      expect(resolved.nodeImport).toStrictEqual({
        written: "./loader.mjs",
        resolved: "./loader.mjs",
      });
    });
  });
});
