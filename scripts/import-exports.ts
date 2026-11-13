import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isImportable(subpath: string): boolean {
  return !subpath.includes("*") && !subpath.endsWith(".json");
}

/**
 * List the importable subpaths of a package.json `exports` field, skipping wildcard and JSON ones.
 *
 * @param exports - The `exports` field as parsed from package.json.
 * @returns Subpaths such as `"."` and `"./cli"`.
 * @throws Error when `exports` is undefined.
 */
export function exportSubpaths(exports: unknown): string[] {
  if (exports === undefined) {
    throw new Error("package has no exports field");
  }
  const keys = isRecord(exports) ? Object.keys(exports) : [];
  const isSubpathMap = keys.some((key) => key.startsWith("."));
  return isSubpathMap ? keys.filter(isImportable) : ["."];
}

async function importExports(name: string): Promise<void> {
  const manifestPath = join(process.cwd(), "node_modules", name, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exports = isRecord(manifest) ? manifest["exports"] : undefined;
  for (const subpath of exportSubpaths(exports)) {
    const specifier = name + subpath.slice(1);
    try {
      await import(specifier);
    } catch (error) {
      throw new Error(`failed to import ${specifier}`, { cause: error });
    }
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  existsSync(entry) &&
  realpathSync(entry) === fileURLToPath(import.meta.url)
) {
  const name = process.argv[2];
  if (name === undefined) {
    throw new Error("usage: node import-exports.ts <package-name>");
  }
  await importExports(name);
}
