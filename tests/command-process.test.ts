import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fixturePath } from "./fixture-path.js";
import { reportAt } from "./report-file.js";
import { spawnCommand } from "./spawn-command.js";
import { POSIX, SPAWN_TIMEOUT_MS } from "./spawn-limits.js";
import { temporaryDir } from "./temporary-dir.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The absolute path of the command fixture `name`. */
function commandFixture(name: string): string {
  return fixturePath("command", name);
}

/** A fresh directory for a spawned command's report, removed when the test ends. */
function reportDir(): string {
  return temporaryDir("repset-command-e2e-");
}

describe("the command started as a process", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when a case throws", () => {
    it("exits 1 with the error in the result", async () => {
      const out = join(reportDir(), "report.json");

      const { code } = await spawnCommand(ROOT, [
        commandFixture("throws.bench.ts"),
        "--node-import",
        "tsx",
        "--min-time",
        "1",
        "--output",
        out,
      ]);

      expect({
        code,
        errors: reportAt(out).results.map((result) => result.error?.message),
      }).toStrictEqual({ code: 1, errors: ["banana"] });
    });
  });

  describe("on SIGINT", () => {
    it.runIf(POSIX)("exits 130, killing the running case", async () => {
      const out = join(reportDir(), "report.json");

      const { code } = await spawnCommand(
        ROOT,
        [
          commandFixture("sum.bench.ts"),
          "--node-import",
          "tsx",
          "--min-time",
          "600000",
          "--output",
          out,
        ],
        (stderr, stop) => {
          if (stderr.includes("sum/small")) stop("SIGINT");
        },
      );

      const report = reportAt(out);
      expect({ code, interrupted: report.interrupted, results: report.results }).toStrictEqual({
        code: 130,
        interrupted: true,
        results: [],
      });
    });
  });
});
