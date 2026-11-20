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

/** The report path inside a fresh directory, removed when the test ends. */
function reportPath(): string {
  return join(temporaryDir("repset-command-e2e-"), "report.json");
}

/** The command's arguments for the fixture `fixture`, with `--min-time` `minTime` and the report at `out`. */
function argsFor(fixture: string, minTime: string, out: string): string[] {
  return [commandFixture(fixture), "--node-import", "tsx", "--min-time", minTime, "--output", out];
}

describe("the command started as a process", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("when a case throws", () => {
    it("exits 1 with the error in the result", async () => {
      const out = reportPath();

      const { code } = await spawnCommand(ROOT, argsFor("throws.bench.ts", "1", out));

      expect({
        code,
        errors: reportAt(out).results.map((result) => result.error?.message),
      }).toStrictEqual({ code: 1, errors: ["banana"] });
    });
  });

  describe("on SIGINT", () => {
    it.runIf(POSIX)("exits 130, killing the running case", async () => {
      const out = reportPath();

      const { code } = await spawnCommand(
        ROOT,
        argsFor("sum.bench.ts", "600000", out),
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
