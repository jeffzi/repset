import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";

import { checkMiseLock } from "../scripts/check-mise-lock.js";

const PLATFORMS = ["macos-arm64", "linux-x64", "windows-x64"] as const;

type Platform = (typeof PLATFORMS)[number];

/** A complete download for one platform. */
function asset(platform: Platform): { url: string; checksum: string } {
  return {
    url: `https://example.invalid/release/${platform}.tar.gz`,
    checksum: `sha256:${platform}`,
  };
}

/**
 * One locked version of a tool, complete on every platform.
 *
 * @param version - The locked version.
 * @returns The tool's lock entry.
 */
function entry(version: string): Record<string, unknown> {
  const locked: Record<string, unknown> = { version };
  for (const platform of PLATFORMS) {
    locked[`platforms.${platform}`] = asset(platform);
  }
  return locked;
}

/** Renders a mise.lock with the given tools, in insertion order. */
function lockfile(tools: Record<string, unknown>): string {
  return stringify({ lockfile_version: 3, tools });
}

const TASK = "aqua:go-task/task";

describe("checkMiseLock", () => {
  describe("when every entry is locked on every platform", () => {
    it("returns without throwing", () => {
      const text = lockfile({
        [TASK]: [entry("3.54.0"), entry("3.53.1")],
        "npm:prettier": [entry("3.6.2")],
      });

      expect(() => {
        checkMiseLock(text);
      }).not.toThrow();
    });
  });
});
