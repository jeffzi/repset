import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { embedCode } from "../scripts/embed-code.js";
import { temporaryDir } from "./temporary-dir.js";

const FENCE = "```";

/** Writes each file under a fresh directory, creating parent directories, and returns the directory. */
function createProject(files: Record<string, string>): string {
  const dir = temporaryDir("embed-code-");
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** A `CODE` block embedding `src`, holding `content` between its markers. */
function codeBlock(src: string, content = "", attributes = ""): string {
  return `<!-- docs CODE src="${src}"${attributes} -->\n${content}\n<!-- /docs -->`;
}

/** The content of the first `CODE` block in `markdown`, without its surrounding newlines. */
function codeBlockContent(markdown: string): string | undefined {
  return /<!-- docs CODE [^>]*-->(?<content>[\s\S]*?)<!-- \/docs -->/u
    .exec(markdown)
    ?.groups?.["content"]?.replace(/^\n+|\n+$/gu, "");
}

/** The content of `path` under `dir`. */
function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

describe("embedCode", () => {
  describe("when a markdown file holds a CODE block", () => {
    it("returns the markdown file as changed", async () => {
      const dir = createProject({
        "docs/snippets/x.ts": "export const x = 1;\nexport const y = 2;\n",
        "README.md": `# Title\n\n${codeBlock("./docs/snippets/x.ts", "stale")}\n`,
      });

      const changed = await embedCode([join(dir, "README.md")]);

      expect(changed).toStrictEqual([join(dir, "README.md")]);
    });

    it("resolves a src starting with ../ from the markdown file's directory", async () => {
      const dir = createProject({
        "snippets/x.ts": "export const x = 1;\n",
        "docs/guide.md": `${codeBlock("../snippets/x.ts")}\n`,
      });

      await embedCode([join(dir, "docs/guide.md")]);

      expect(codeBlockContent(read(dir, "docs/guide.md"))).toBe(
        `${FENCE}ts\nexport const x = 1;\n${FENCE}`,
      );
    });

    it("omits lines holding only an oxlint or fallow-ignore directive comment", async () => {
      const dir = createProject({
        "x.ts": [
          "// oxlint-disable no-console",
          "// fallow-ignore-next-line code-duplication -- a reason",
          "function log(): void {",
          "  // oxlint-disable-next-line no-console",
          "  console.log(1); // oxlint-disable-line no-console",
          "  // a plain comment",
          "}",
          "// oxlint-enable no-console",
          "",
        ].join("\n"),
        "README.md": `${codeBlock("./x.ts")}\n`,
      });

      await embedCode([join(dir, "README.md")]);

      expect(codeBlockContent(read(dir, "README.md"))).toBe(
        [
          `${FENCE}ts`,
          "function log(): void {",
          "  console.log(1); // oxlint-disable-line no-console",
          "  // a plain comment",
          "}",
          FENCE,
        ].join("\n"),
      );
    });

    it("shows the header option first in the fence", async () => {
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "README.md": `${codeBlock("./x.ts", "", ' header="// benchmarks/x.bench.ts"')}\n`,
      });

      await embedCode([join(dir, "README.md")]);

      expect(codeBlockContent(read(dir, "README.md"))).toBe(
        `${FENCE}ts\n// benchmarks/x.bench.ts\nexport const x = 1;\n${FENCE}`,
      );
    });
  });

  describe("when a markdown file holds no CODE block", () => {
    it("returns no changed files", async () => {
      const dir = createProject({ "README.md": "# Title\n\nPlain text.\n" });

      const changed = await embedCode([join(dir, "README.md")]);

      expect(changed).toStrictEqual([]);
    });
  });

  describe("when a CODE block's src does not start with ./ or ../", () => {
    it("rejects naming the markdown file and the src", async () => {
      const src = "https://example.invalid/x.ts";
      const dir = createProject({ "b.md": `${codeBlock(src, "stale")}\n` });

      const run = embedCode([join(dir, "b.md")]);

      await expect(run).rejects.toThrow(src);
      await expect(run).rejects.toThrow(join(dir, "b.md"));
    });
  });

  describe("when a later markdown file fails", () => {
    it("writes no file", async () => {
      const valid = `${codeBlock("./x.ts", "stale")}\n`;
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "a.md": valid,
        "b.md": `${codeBlock("https://example.invalid/x.ts", "stale")}\n`,
      });

      await embedCode([join(dir, "a.md"), join(dir, "b.md")]).catch(() => undefined);

      expect(read(dir, "a.md")).toBe(valid);
    });
  });

  describe("when a CODE block's source file is missing", () => {
    it("rejects naming the missing path", async () => {
      const dir = createProject({ "README.md": `${codeBlock("./missing.ts", "stale")}\n` });

      const run = embedCode([join(dir, "README.md")]);

      await expect(run).rejects.toThrow(join(dir, "missing.ts"));
    });
  });
});
