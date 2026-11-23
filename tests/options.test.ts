import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "../src/measure/measure.js";
import {
  ConfigError,
  DEFAULT_INCLUDE,
  DEFAULT_RUNTIMES,
  DEFAULT_TIMEOUT,
  resolveOptions,
  type OptionsInput,
} from "../src/options.js";
import { expectConfigError } from "./config-error.js";
import { fixturePath } from "./fixture-path.js";
import { SPAWN_TIMEOUT_MS } from "./spawn-limits.js";

const FIXTURES = fixturePath("config");

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const OPTIONS_MODULE = new URL("../src/options.ts", import.meta.url).href;

/** The `minSampleCount` that `config` resolves to in a spawned Node process, through Node's own loader. */
function minSampleCountInNode(config: string): string {
  const script = [
    `const { resolveOptions } = await import(${JSON.stringify(OPTIONS_MODULE)});`,
    `const resolved = await resolveOptions({ cwd: ${JSON.stringify(FIXTURES)}, config: ${JSON.stringify(config)} });`,
    "process.stdout.write(String(resolved.minSampleCount));",
  ].join("\n");
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

/** The absolute path of the config fixture `name`. */
function fixture(name: string): string {
  return fixturePath("config", name);
}

/** Resolves `options` from the fixture directory, which holds no `repset.config.*` file. */
async function resolveHere(options: Partial<OptionsInput> = {}): ReturnType<typeof resolveOptions> {
  return resolveOptions({ cwd: FIXTURES, ...options });
}

/** What a resolution with nothing given yields. */
const DEFAULTS = {
  include: DEFAULT_INCLUDE,
  includeBase: FIXTURES,
  runtimes: DEFAULT_RUNTIMES,
  minTime: DEFAULT_MIN_TIME,
  minSampleCount: DEFAULT_MIN_SAMPLES,
  contestRepetitionCount: undefined,
  debug: false,
  timeout: DEFAULT_TIMEOUT,
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

      expect(resolved.minSampleCount).toBe(3);
    });

    it("rejects a working directory that holds several config files, naming them", async () => {
      const result = resolveOptions({ cwd: fixture("several") });

      await expectConfigError(result, ["repset.config.ts", "repset.config.mts"]);
    });
  });

  describe("when a config is named", () => {
    it.each([{ path: "missing.ts" }, { path: "nested" }])(
      "rejects $path, which holds no file, naming it",
      async ({ path }) => {
        const result = resolveHere({ config: path });

        await expectConfigError(result, [path]);
      },
    );

    it("reads a file whose path a raw import would misread", { timeout: SPAWN_TIMEOUT_MS }, () => {
      const minSampleCount = minSampleCountInNode("hash#name.ts");

      expect(minSampleCount).toBe("6");
    });

    it("rejects a config path the file system cannot stat", async () => {
      const result = resolveHere({ config: "apple\0.ts" });

      await expect(result).rejects.toBeInstanceOf(ConfigError);
    });
  });

  describe("when the config file cannot be imported", () => {
    it("rejects a top-level throw, naming the file and carrying its message", async () => {
      const result = resolveHere({ config: "top-level-throw.ts" });

      await expectConfigError(result, ["top-level-throw.ts", "banana"]);
    });

    it("rejects a default export whose getter throws, naming the file and carrying its message", async () => {
      const result = resolveHere({ config: "getter-throws.ts" });

      await expectConfigError(result, ["getter-throws.ts", "pear"]);
    });
  });

  describe("when the default export is not a plain object", () => {
    it.each([{ name: "no-default.ts" }, { name: "default-promise.ts" }])(
      "rejects $name, naming the file",
      async ({ name }) => {
        const result = resolveHere({ config: name });

        await expectConfigError(result, [name]);
      },
    );
  });

  describe("when the config file holds a key that is not an option", () => {
    it("rejects the key, naming it", async () => {
      const result = resolveHere({ config: "unknown-key.ts" });

      await expectConfigError(result, ["banana"]);
    });

    it("treats the key as absent when it holds undefined", async () => {
      const resolved = await resolveHere({ config: "unknown-undefined.ts" });

      expect(resolved).toStrictEqual(DEFAULTS);
    });
  });

  describe("when the config file gives a bad value", () => {
    it.each([
      { name: "include-string.ts", option: "include", shown: "*.bench.ts" },
      { name: "include-number.ts", option: "include", shown: "7" },
      { name: "runtime-unknown.ts", option: "runtimes", shown: "deno" },
      { name: "node-import-number.ts", option: "nodeImport", shown: "5" },
      { name: "debug-string.ts", option: "debug", shown: "yes" },
    ])("rejects $name, naming $option and the value", async ({ name, option, shown }) => {
      const result = resolveHere({ config: name });

      await expectConfigError(result, [option, shown]);
    });
  });

  describe("when the caller gives a bad value", () => {
    it("rejects an empty runtimes list", async () => {
      const result = resolveHere({ runtimes: [] });

      await expectConfigError(result, []);
    });

    it.each<{ options: Partial<OptionsInput>; option: string; shown: string }>([
      { options: { runtimes: ["node", "bun", "node"] }, option: "runtimes", shown: "node" },
      { options: { minTime: -1 }, option: "minTime", shown: "-1" },
      { options: { minTime: Number.NaN }, option: "minTime", shown: "NaN" },
      { options: { minSampleCount: 1.5 }, option: "minSampleCount", shown: "1.5" },
      {
        options: { contestRepetitionCount: 0 },
        option: "contestRepetitionCount",
        shown: "0",
      },
      { options: { timeout: 0 }, option: "timeout", shown: "0" },
      { options: { timeout: 2.5 }, option: "timeout", shown: "2.5" },
      { options: { timeout: 2_147_483_648 }, option: "timeout", shown: "2147483648" },
      { options: { filter: "(" }, option: "filter", shown: "(" },
    ])(
      "rejects $option $shown, naming the option and the value",
      async ({ options, option, shown }) => {
        const result = resolveHere(options);

        await expectConfigError(result, [option, shown]);
      },
    );
  });

  describe("when the caller gives a boundary value", () => {
    it("accepts a timeout of 1", async () => {
      const resolved = await resolveHere({ timeout: 1 });

      expect(resolved.timeout).toBe(1);
    });
  });

  describe("when an option is given in more than one place", () => {
    it("takes every option the config file gives over the default", async () => {
      const resolved = await resolveHere({ config: "all-options.ts" });

      expect(resolved).toStrictEqual({
        include: ["bench/*.ts"],
        includeBase: FIXTURES,
        runtimes: ["bun", "node"],
        minTime: 0,
        minSampleCount: 1,
        contestRepetitionCount: 1,
        debug: true,
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
        minSampleCount: 9,
        contestRepetitionCount: 6,
        debug: false,
        timeout: 200,
        nodeImport: "jiti",
        filter: "^a",
      });

      expect(resolved).toStrictEqual({
        include: ["*.bench.mjs"],
        includeBase: FIXTURES,
        runtimes: ["node"],
        minTime: 7,
        minSampleCount: 9,
        contestRepetitionCount: 6,
        debug: false,
        timeout: 200,
        nodeImport: { written: "jiti", resolved: "jiti" },
        filter: /^a/u,
      });
    });
  });

  describe("when a path option is relative", () => {
    it("bases include on the config file's directory", async () => {
      const resolved = await resolveHere({ config: "nested/include.ts" });

      expect(resolved.includeBase).toBe(fixture("nested"));
    });

    it.each([
      {
        name: "nested/dot-import.ts",
        written: "./loader.mjs",
        resolved: pathToFileURL(fixture("nested/loader.mjs")).href,
      },
      {
        name: "nested/parent-import.ts",
        written: "../loader.mjs",
        resolved: pathToFileURL(fixture("loader.mjs")).href,
      },
    ])(
      "resolves the config file's $written to the file URL beside it, keeping it as written",
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
