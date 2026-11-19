import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runtimesHere } from "./real-bun.js";
import { spawnCommand, TSX } from "./spawn-command.js";
import { SPAWN_TIMEOUT_MS } from "./spawn-limits.js";

/** The files the README embeds; each imports `repset`, which resolves to the built `dist/`. */
const SNIPPETS = fileURLToPath(new URL("../docs/snippets/", import.meta.url));

/** Every snippet file, by name. */
const SNIPPET_FILES = readdirSync(SNIPPETS).filter((name) => name.endsWith(".bench.ts"));

describe("the README's snippet files", () => {
  describe.each(runtimesHere())("on $runtime", ({ runtime, here }) => {
    describe.runIf(here)("when each runs alone", () => {
      it.each(SNIPPET_FILES)(
        "runs %s once with every case ok",
        { timeout: SPAWN_TIMEOUT_MS },
        async (snippet) => {
          const { code, stderr } = await spawnCommand(SNIPPETS, [
            "--once",
            "--runtime",
            runtime,
            "--node-import",
            TSX,
            snippet,
          ]);

          // oxlint-disable-next-line vitest/valid-expect -- Vitest takes a failure message as expect's second argument
          expect(code, stderr).toBe(0);
        },
      );
    });
  });
});
