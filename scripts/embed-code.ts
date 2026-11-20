/**
 * Embeds source files into markdown: each `<!-- docs CODE src="./x.ts" -->` block's content becomes
 * a `ts` fence holding the file at `src`, resolved from the markdown file's directory.
 *
 * Run as `node scripts/embed-code.ts <markdown files>`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const FENCE = "```";

/**
 * A `CODE` block: its attributes, then its content split into the newlines that open it, the text
 * between them, and the newlines that close it, so a rewrite keeps the layout as written.
 */
const CODE_BLOCK =
  /<!-- docs CODE(?<attributes>\s[\s\S]*?)?-->(?<before>\n*)(?<content>[\s\S]*?)(?<after>\n*)<!-- \/docs -->/gu;

const ATTRIBUTE = /(?<name>[\w-]+)="(?<value>[^"]*)"/gu;

/**
 * A line holding nothing but an oxlint or fallow directive comment: it is addressed to this repo's
 * checkers, and readers of the docs do not need it.
 */
const CHECKER_DIRECTIVE = /^\s*\/\/\s*(?:oxlint-(?:disable|enable)|fallow-ignore-)/u;

const RELATIVE_SRC = /^\.\.?\//u;

function parseAttributes(attributes: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const { groups } of attributes.matchAll(ATTRIBUTE)) {
    if (groups?.["name"] !== undefined && groups["value"] !== undefined) {
      parsed.set(groups["name"], groups["value"]);
    }
  }
  return parsed;
}

async function fence(markdownPath: string, attributes: string): Promise<string> {
  const options = parseAttributes(attributes);
  const src = options.get("src");
  if (src === undefined) {
    throw new Error(`a CODE block in ${markdownPath} has no double-quoted src option`);
  }
  if (!RELATIVE_SRC.test(src)) {
    throw new Error(`${markdownPath}: CODE src "${src}" must start with ./ or ../`);
  }
  const codePath = resolve(dirname(markdownPath), src);
  let code: string;
  try {
    code = await readFile(codePath, "utf8");
  } catch (error) {
    throw new Error(`${markdownPath}: cannot read CODE src ${codePath}`, { cause: error });
  }
  const shown = code
    .replace(/\n$/u, "")
    .split("\n")
    .filter((line) => !CHECKER_DIRECTIVE.test(line));
  const header = options.get("header");
  if (header !== undefined) shown.unshift(header);
  return [`${FENCE}ts`, ...shown, FENCE].join("\n");
}

async function embedFile(markdownPath: string, markdown: string): Promise<string> {
  const blocks = [...markdown.matchAll(CODE_BLOCK)];
  const fences = await Promise.all(
    blocks.map(async ({ groups }) => fence(markdownPath, groups?.["attributes"] ?? "")),
  );
  let embedded = "";
  let end = 0;
  for (const [index, block] of blocks.entries()) {
    const { attributes = "", before = "", content = "", after = "" } = block.groups ?? {};
    // A block holding no text, or text flush against a marker, gets the fence on its own lines.
    const opening = content === "" || before === "" ? "\n" : before;
    const closing = content === "" || after === "" ? "\n" : after;
    embedded += markdown.slice(end, block.index);
    embedded += `<!-- docs CODE${attributes}-->${opening}${fences[index]}${closing}<!-- /docs -->`;
    end = block.index + block[0].length;
  }
  return embedded + markdown.slice(end);
}

/**
 * Rewrite each `CODE` block in the given markdown files to a `ts` fence holding its source file,
 * without the lines that hold only an oxlint or fallow directive, under the block's `header` option
 * if any. Markers other than `CODE` are left as they are, and the newlines around a block's content
 * are kept as written. No file is written until every file has been embedded.
 *
 * @param files - Paths of the markdown files to rewrite.
 * @returns The markdown files that changed.
 * @throws Error naming the markdown file when a `CODE` block has no double-quoted `src` option or
 *   its `src` does not start with `./` or `../`, or naming the path of a source file that cannot be
 *   read.
 * @throws Error from the filesystem when a markdown file cannot be read or written.
 */
export async function embedCode(files: readonly string[]): Promise<string[]> {
  const embeddings = await Promise.all(
    files.map(async (file) => {
      const original = await readFile(file, "utf8");
      return { file, original, updated: await embedFile(file, original) };
    }),
  );
  const changed = embeddings.filter(({ original, updated }) => updated !== original);
  await Promise.all(changed.map(async ({ file, updated }) => writeFile(file, updated)));
  return changed.map(({ file }) => file);
}

if (import.meta.main) {
  for (const file of await embedCode(process.argv.slice(2))) {
    console.log(`embedded code in ${file}`);
  }
}
