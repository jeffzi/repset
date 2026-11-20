import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { embedCode } from "../scripts/embed-code.js";
import { temporaryProject } from "./temporary-dir.js";

const FENCE = "```";

/** A fresh directory holding each of `files`, removed when the test ends. */
function createProject(files: Record<string, string>): string {
  return temporaryProject("embed-code-", files);
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

  describe("when a CODE block's content is stale", () => {
    it("returns the markdown file as changed", async () => {
      const dir = createProject({
        "docs/snippets/x.ts": "export const x = 1;\nexport const y = 2;\n",
        "README.md": `# Title\n\n${codeBlock("./docs/snippets/x.ts", "stale")}\n`,
      });

      const changed = await embedCode([join(dir, "README.md")]);

      expect(changed).toStrictEqual([join(dir, "README.md")]);
    });

    it.each([
      { written: "a blank line", around: "\n\n", result: "a blank line", output: "\n\n" },
      { written: "no newline", around: "", result: "one newline", output: "\n" },
    ])(
      "writes $result around the fence when the content has $written around it",
      async ({ around, output }) => {
        const dir = createProject({
          "x.ts": "export const x = 1;\n",
          "README.md": `<!-- docs CODE src="./x.ts" -->${around}stale${around}<!-- /docs -->\n`,
        });

        await embedCode([join(dir, "README.md")]);

        expect(read(dir, "README.md")).toBe(
          `<!-- docs CODE src="./x.ts" -->${output}${FENCE}ts\nexport const x = 1;\n${FENCE}${output}<!-- /docs -->\n`,
        );
      },
    );
  });

  describe("when a CODE block with attributes on their own lines is up to date", () => {
    it("returns no changed files", async () => {
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "README.md": [
          "<!-- docs CODE",
          '  src="./x.ts"',
          "-->",
          `${FENCE}ts`,
          "export const x = 1;",
          FENCE,
          "<!-- /docs -->",
          "",
        ].join("\n"),
      });

      const changed = await embedCode([join(dir, "README.md")]);

      expect(changed).toStrictEqual([]);
    });
  });

  describe("when a markdown file holds no CODE block", () => {
    it("leaves a block with another marker unchanged", async () => {
      const dir = createProject({ "README.md": "<!-- docs OTHER -->\nkeep\n<!-- /docs -->\n" });

      const changed = await embedCode([join(dir, "README.md")]);

      expect(changed).toStrictEqual([]);
    });
  });

  describe("when a CODE block has no double-quoted src", () => {
    it.each([
      { attributes: "no attribute", opening: "<!-- docs CODE -->" },
      { attributes: "a single-quoted src", opening: "<!-- docs CODE src='./x.ts' -->" },
    ])("rejects, naming the markdown file, a block with $attributes", async ({ opening }) => {
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "b.md": `${opening}\nstale\n<!-- /docs -->\n`,
      });

      const run = embedCode([join(dir, "b.md")]);

      await expect(run).rejects.toThrow(join(dir, "b.md"));
    });
  });

  describe("when a CODE block's src does not start with ./ or ../", () => {
    it("rejects, naming where the src is written", async () => {
      const src = "https://example.invalid/x.ts";
      const dir = createProject({ "b.md": `${codeBlock(src, "stale")}\n` });

      const run = embedCode([join(dir, "b.md")]);

      await expect(run).rejects.toThrow(src);
      await expect(run).rejects.toThrow(join(dir, "b.md"));
    });
  });

  describe("when a later markdown file fails", () => {
    const VALID = `${codeBlock("./x.ts", "stale")}\n`;

    it("leaves the earlier file unchanged", async () => {
      const dir = createProject({
        "x.ts": "export const x = 1;\n",
        "a.md": VALID,
        "b.md": `${codeBlock("https://example.invalid/x.ts", "stale")}\n`,
      });

      const run = embedCode([join(dir, "a.md"), join(dir, "b.md")]);

      await expect(run).rejects.toThrow(join(dir, "b.md"));
      expect(read(dir, "a.md")).toBe(VALID);
    });
  });

  describe("when a CODE block's source file is missing", () => {
    it("rejects, naming the missing path", async () => {
      const dir = createProject({ "README.md": `${codeBlock("./missing.ts", "stale")}\n` });

      const run = embedCode([join(dir, "README.md")]);

      await expect(run).rejects.toThrow(join(dir, "missing.ts"));
    });
  });
});
