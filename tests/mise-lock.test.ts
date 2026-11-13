import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";

import { checkMiseLock } from "../scripts/check-mise-lock.js";

const PLATFORMS = ["macos-arm64", "linux-x64", "windows-x64"] as const;

type Platform = (typeof PLATFORMS)[number];

interface Asset {
  url?: string;
  checksum?: string;
}

/** A complete download for one platform. */
function asset(platform: Platform): Asset {
  return {
    url: `https://example.invalid/release/${platform}.tar.gz`,
    checksum: `sha256:${platform}`,
  };
}

/**
 * One locked version of a tool, complete on every platform unless overridden (`null` omits the
 * platform table).
 */
function entry(
  version: string,
  overrides: Partial<Record<Platform, Asset | null>> = {},
): Record<string, unknown> {
  const locked: Record<string, unknown> = { version };
  for (const platform of PLATFORMS) {
    const override = overrides[platform];
    if (override === null) {
      continue;
    }
    locked[`platforms.${platform}`] = override ?? asset(platform);
  }
  return locked;
}

/** Renders a mise.lock with the given tools, in insertion order. */
function lockfile(tools: Record<string, unknown>): string {
  return stringify({ lockfile_version: 3, tools });
}

/** Matches every part, in the given order, anywhere in the text. */
function inOrder(...parts: string[]): RegExp {
  const escaped = parts.map((part) => part.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`));
  return new RegExp(escaped.join(String.raw`[\s\S]*`));
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

  describe("when an entry has a gap on a platform", () => {
    it.each([
      { gap: "no platform table", override: null },
      { gap: "no url", override: { checksum: "sha256:windows-x64" } },
      { gap: "no checksum", override: { url: "https://example.invalid/release/windows.zip" } },
      {
        gap: "an empty checksum",
        override: { url: "https://example.invalid/release/windows.zip", checksum: "" },
      },
    ])("throws naming the tool, version and platform when it has $gap", ({ override }) => {
      const text = lockfile({ [TASK]: [entry("3.54.0", { "windows-x64": override })] });

      expect(() => {
        checkMiseLock(text);
      }).toThrow(`${TASK}@3.54.0 on windows-x64`);
    });

    it("names every gap in lockfile order", () => {
      const text = lockfile({
        "npm:prettier": [
          entry("3.6.2", { "windows-x64": null }),
          entry("3.5.0", { "linux-x64": { url: "https://example.invalid/release/linux.tar.gz" } }),
        ],
        [TASK]: [entry("3.54.0"), entry("3.53.1", { "macos-arm64": null })],
      });

      expect(() => {
        checkMiseLock(text);
      }).toThrow(
        inOrder(
          "npm:prettier@3.6.2 on windows-x64",
          "npm:prettier@3.5.0 on linux-x64",
          `${TASK}@3.53.1 on macos-arm64`,
        ),
      );
    });
  });

  describe("when the lockfile has no tools table", () => {
    it.each([
      { shape: "missing", text: "lockfile_version = 3\n" },
      { shape: "an array", text: "lockfile_version = 3\ntools = []\n" },
    ])("throws naming tools when it is $shape", ({ text }) => {
      expect(() => {
        checkMiseLock(text);
      }).toThrow(/tools/);
    });
  });

  describe("when a tool's entries are malformed", () => {
    it.each([
      { shape: "a table instead of an array", entries: entry("3.54.0") },
      { shape: "an array holding a string", entries: ["3.54.0"] },
      { shape: "an entry with a numeric version", entries: [{ ...entry("3.54.0"), version: 3 }] },
    ])("throws naming the tool when they are $shape", ({ entries }) => {
      const text = lockfile({ [TASK]: entries });

      expect(() => {
        checkMiseLock(text);
      }).toThrow(TASK);
    });
  });
});
