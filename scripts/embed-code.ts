/**
 * Embeds source files into markdown: each `<!-- docs CODE src="./x.ts" -->` block's content becomes
 * a `ts` fence holding the file at `src`, resolved from the markdown file's directory.
 *
 * Run as `node --import tsx scripts/embed-code.ts <markdown files>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { isRecord } from "../src/utils.js";

/** The fields of a markdown-magic transform's argument this script reads. */
interface TransformInput {
  readonly options: unknown;
  readonly srcPath: unknown;
}

type ProcessFile = (options: Record<string, unknown>) => Promise<unknown>;

const FENCE = "```";

/** A line holding nothing but an oxlint directive comment, which readers of the docs do not need. */
const OXLINT_DIRECTIVE = /^\s*\/\/\s*oxlint-(?:disable|enable)\b/u;

const RELATIVE_SRC = /^\.\.?\//u;

function isProcessFile(value: unknown): value is ProcessFile {
  return typeof value === "function";
}

/**
 * markdown-magic's `processFile` runs only the transforms it is given. Its `markdownMagic` merges
 * them over its built-ins, which would keep `remote` fetching URLs and `TOC` rewriting its block.
 */
function loadProcessFile(): ProcessFile {
  // markdown-magic is CommonJS and ships no types, so it is loaded as an untyped value and narrowed.
  const module: unknown = createRequire(import.meta.url)("markdown-magic");
  const processFile = isRecord(module) ? module["processFile"] : undefined;
  if (!isProcessFile(processFile)) {
    throw new Error("markdown-magic exports no processFile function");
  }
  return processFile;
}

function embed({ options, srcPath }: TransformInput): string {
  const fields: Record<string, unknown> = isRecord(options) ? options : {};
  const { src, header } = fields;
  if (typeof srcPath !== "string" || typeof src !== "string") {
    throw new Error(`a CODE block in ${String(srcPath)} has no src option`);
  }
  if (!RELATIVE_SRC.test(src)) {
    throw new Error(`${srcPath}: CODE src "${src}" must start with ./ or ../`);
  }
  const path = resolve(dirname(srcPath), src);
  let code: string;
  try {
    code = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${srcPath}: cannot read CODE src ${path}`, { cause: error });
  }
  const shown = code
    .replace(/\n$/u, "")
    .split("\n")
    .filter((line) => !OXLINT_DIRECTIVE.test(line));
  if (typeof header === "string") shown.unshift(header);
  return [`${FENCE}ts`, ...shown, FENCE].join("\n");
}

async function embedFile(processFile: ProcessFile, file: string, content: string): Promise<string> {
  const result = await processFile({
    content,
    srcPath: file,
    open: "docs",
    close: "/docs",
    transforms: { CODE: embed },
  });
  const updated = isRecord(result) ? result["updatedContents"] : undefined;
  if (typeof updated !== "string") {
    throw new TypeError(`markdown-magic returned no updated contents for ${file}`);
  }
  return updated;
}

/**
 * Rewrite each `CODE` block in the given markdown files to a `ts` fence holding its source file,
 * without the lines that hold only an oxlint directive, under the block's `header` option if any.
 * Markers other than `CODE` are left as they are. No file is written until every file has been
 * embedded.
 *
 * @param files - Paths of the markdown files to rewrite.
 * @returns The markdown files that changed.
 * @throws Error naming the markdown file when a `CODE` block has no `src` option or its `src` does
 *   not start with `./` or `../`, or naming the path of a source file that cannot be read.
 * @throws Error when markdown-magic exports no `processFile` function.
 * @throws TypeError when markdown-magic returns no updated contents.
 * @throws Error from the filesystem when a markdown file cannot be read or written.
 */
export async function embedCode(files: readonly string[]): Promise<string[]> {
  const processFile = loadProcessFile();
  const changes: [file: string, content: string][] = [];
  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const updated = await embedFile(processFile, file, original);
    if (updated !== original) changes.push([file, updated]);
  }
  for (const [file, content] of changes) writeFileSync(file, content);
  return changes.map(([file]) => file);
}

if (import.meta.main) {
  for (const file of await embedCode(process.argv.slice(2))) {
    console.log(`embedded code in ${file}`);
  }
}
