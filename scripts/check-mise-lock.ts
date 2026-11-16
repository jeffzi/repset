import { readFileSync } from "node:fs";

import { parse } from "smol-toml";

import { isRecord } from "../src/utils.js";

const LOCKFILE = "mise.lock";
const PLATFORMS = ["macos-arm64", "linux-x64", "windows-x64"] as const;

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isLocked(asset: unknown): boolean {
  return isRecord(asset) && isNonEmptyString(asset["url"]) && isNonEmptyString(asset["checksum"]);
}

interface LockedEntry {
  version: string;
  table: Record<string, unknown>;
}

function readEntries(tool: string, entries: unknown): LockedEntry[] {
  if (!Array.isArray(entries) || !entries.every(isRecord)) {
    throw new Error(`${LOCKFILE}: tools."${tool}" must be an array of tables`);
  }
  return entries.map((table) => {
    const version = table["version"];
    if (typeof version !== "string") {
      throw new Error(`${LOCKFILE}: an entry of tools."${tool}" has no string version`);
    }
    return { version, table };
  });
}

function platformGaps(tool: string, { version, table }: LockedEntry): string[] {
  return PLATFORMS.filter((platform) => !isLocked(table[`platforms.${platform}`])).map(
    (platform) => `${tool}@${version} on ${platform}`,
  );
}

/**
 * Fail unless every `mise.lock` entry has a url and checksum for each platform in `PLATFORMS`.
 *
 * @param text - Contents of `mise.lock`.
 * @throws Error naming each gap as `tool@version on platform`, or the malformed part.
 */
export function checkMiseLock(text: string): void {
  const lock = parse(text);
  const tools: unknown = lock["tools"];
  if (!isRecord(tools)) {
    throw new Error(`${LOCKFILE} has no tools table`);
  }

  const gaps: string[] = [];
  for (const [tool, entries] of Object.entries(tools)) {
    for (const entry of readEntries(tool, entries)) {
      gaps.push(...platformGaps(tool, entry));
    }
  }

  if (gaps.length > 0) {
    throw new Error(`${LOCKFILE} lacks a url and checksum for ${gaps.join(", ")}`);
  }
}

if (import.meta.main) {
  checkMiseLock(readFileSync(LOCKFILE, "utf8"));
}
