/**
 * Imports every entry of an installed package, to prove the packed package loads.
 *
 * `task check-package` copies this file alone into an empty app beside the installed package, so
 * it imports Node builtins only: an import from `src/` would not resolve there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * List the subpaths of a package.json `exports` field.
 *
 * @param exports - The `exports` field as parsed from package.json.
 * @returns Every key of a subpath map (keys starting with `"."`), or `["."]` when `exports` is a
 *   string or a conditions-only object.
 * @throws Error when `exports` is undefined.
 */
export function exportSubpaths(exports: unknown): string[] {
  if (exports === undefined) {
    throw new Error("package has no exports field");
  }
  const keys = isRecord(exports) ? Object.keys(exports) : [];
  const isSubpathMap = keys.some((key) => key.startsWith("."));
  return isSubpathMap ? keys : ["."];
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

if (import.meta.main) {
  const name = process.argv[2];
  if (name === undefined) {
    throw new Error("usage: node import-exports.ts <package-name>");
  }
  await importExports(name);
}
