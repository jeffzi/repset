import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { requiresRealBunHere } from "./real-bun.js";
import { spawnCommand, TSX } from "./spawn-command.js";
import { temporaryDir } from "./temporary-dir.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Node, tsx and every example's `--once` child starting, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** The config files the command loads from its working directory; a block at one is the config. */
const CONFIG_NAMES: ReadonlySet<string> = new Set([
  "repset.config.ts",
  "repset.config.mts",
  "repset.config.js",
  "repset.config.mjs",
]);

/** The body of every fenced `ts` block of `text`, in order. */
function tsBlocks(text: string): string[] {
  return [...text.matchAll(/^```ts\n([\s\S]*?)^```$/gmu)].map((match) => match[1] ?? "");
}

/** The path the block's opening `// <path>` comment names, or `undefined` when it names none. */
function openingPath(block: string): string | undefined {
  return /^\/\/ (\S+\.[cm]?[jt]s)\n/u.exec(block)?.[1];
}

const BLOCKS = tsBlocks(readFileSync(join(ROOT, "README.md"), "utf8"));

/** Every block with the path it names; empty when a block names none. */
const NAMED = BLOCKS.map((block, index) => ({
  number: index + 1,
  path: openingPath(block),
  block,
}));

/**
 * Writes every README block at its path in a fresh project whose `repset` package re-exports the
 * source entry.
 *
 * @returns The project's directory.
 * @throws When a block names no path, or a path an earlier block already names.
 */
function exampleProject(): string {
  const dir = temporaryDir("repset-readme-");
  const shim = join(dir, "node_modules", "repset");
  mkdirSync(shim, { recursive: true });
  writeFileSync(
    join(shim, "package.json"),
    JSON.stringify({ name: "repset", type: "module", exports: "./index.js" }),
  );
  const entry = pathToFileURL(join(ROOT, "src", "index.ts")).href;
  writeFileSync(join(shim, "index.js"), `export * from ${JSON.stringify(entry)};\n`);
  const written = new Set<string>();
  for (const { number, path, block } of NAMED) {
    if (path === undefined) throw new Error(`README block ${String(number)} names no file`);
    if (written.has(path)) {
      throw new Error(`README block ${String(number)} names ${path}, which an earlier block names`);
    }
    written.add(path);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), block);
  }
  return dir;
}

describe("the README", () => {
  describe.each([
    { runtime: "node", here: true },
    { runtime: "bun", here: requiresRealBunHere() },
  ])("its examples on $runtime", ({ runtime, here }) => {
    it.runIf(here)(
      "run once with every case ok, listing every benchmark file",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const dir = exampleProject();
        const benchmarks = NAMED.flatMap(({ path }) =>
          path === undefined || CONFIG_NAMES.has(path) ? [] : [path],
        );

        const { code, stderr } = await spawnCommand(dir, [
          "--once",
          "--runtime",
          runtime,
          "--node-import",
          TSX,
        ]);

        const words = stderr.split(/\s+/u);
        expect({
          code,
          unlisted: benchmarks.filter((path) => !words.includes(path)),
        }).toStrictEqual({ code: 0, unlisted: [] });
      },
    );
  });
});
