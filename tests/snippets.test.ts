import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runtimesHere } from "./real-bun.js";
import { spawnCommand, TSX } from "./spawn-command.js";

/** The files the README embeds; each imports `repset`, which resolves to the built `dist/`. */
const SNIPPETS = fileURLToPath(new URL("../docs/snippets/", import.meta.url));

/** Node, tsx and every snippet's `--once` child starting, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

describe("the README's snippet files", () => {
  describe.each(runtimesHere())("on $runtime", ({ runtime, here }) => {
    it.runIf(here)(
      "run once with every case ok, listing every snippet file",
      { timeout: SPAWN_TIMEOUT_MS },
      async () => {
        const snippets = readdirSync(SNIPPETS).filter((name) => name.endsWith(".bench.ts"));

        const { code, stderr } = await spawnCommand(SNIPPETS, [
          "--once",
          "--runtime",
          runtime,
          "--node-import",
          TSX,
        ]);

        const words = stderr.split(/\s+/u);
        expect({
          code,
          unlisted: snippets.filter((name) => !words.includes(name)),
        }).toStrictEqual({ code: 0, unlisted: [] });
      },
    );
  });
});
