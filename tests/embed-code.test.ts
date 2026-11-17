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
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
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
    it("replaces the block's content with a ts fence holding the source file", async () => {
      const dir = createProject({
        "docs/snippets/x.ts": "export const x = 1;\nexport const y = 2;\n",
        "README.md": `# Title\n\n${codeBlock("./docs/snippets/x.ts", "stale")}\n`,
      });

      await embedCode([join(dir, "README.md")]);

      expect(codeBlockContent(read(dir, "README.md"))).toBe(
        `${FENCE}ts\nexport const x = 1;\nexport const y = 2;\n${FENCE}`,
      );
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

    it.each([
      '<!-- docs REMOTE url="https://example.invalid/x.md" -->\nkept\n<!-- /docs -->',
      "<!-- docs banana -->\nkept\n<!-- /docs -->",
    ])("leaves the marker other than CODE %j as it was", async (other) => {
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "README.md": `${codeBlock("./x.ts")}\n\n${other}\n`,
      });

      await embedCode([join(dir, "README.md")]);

      expect(read(dir, "README.md")).toContain(other);
    });
  });

  describe("when a markdown file holds no CODE block", () => {
    it("leaves the file byte for byte as it was", async () => {
      const markdown = "# Title\n\n*  loose   list\n\n\n<!-- docs TOC -->\nkept\n<!-- /docs -->\n";
      const dir = createProject({ "README.md": markdown });

      await embedCode([join(dir, "README.md")]);

      expect(read(dir, "README.md")).toBe(markdown);
    });
  });

  describe("when a CODE block's src does not start with ./ or ../", () => {
    it.each(["docs/x.ts", "https://example.invalid/x.ts", "name.ext/x.ts"])(
      "rejects naming the markdown file and %s, leaving every file as it was",
      async (src) => {
        const valid = `${codeBlock("./x.ts", "stale")}\n`;
        const invalid = `${codeBlock(src, "stale")}\n`;
        const dir = createProject({
          "x.ts": "export const x = 1;\n",
          "a.md": valid,
          "b.md": invalid,
        });

        const run = embedCode([join(dir, "a.md"), join(dir, "b.md")]);

        await expect(run).rejects.toThrow(src);
        await expect(run).rejects.toThrow(join(dir, "b.md"));
        expect([read(dir, "a.md"), read(dir, "b.md")]).toStrictEqual([valid, invalid]);
      },
    );
  });

  describe("when a CODE block's source file is missing", () => {
    it("rejects naming the missing path, leaving the markdown file as it was", async () => {
      const markdown = `${codeBlock("./missing.ts", "stale")}\n`;
      const dir = createProject({ "README.md": markdown });

      const run = embedCode([join(dir, "README.md")]);

      await expect(run).rejects.toThrow(join(dir, "missing.ts"));
      expect(read(dir, "README.md")).toBe(markdown);
    });
  });
});
