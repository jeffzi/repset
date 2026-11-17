import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reportAt } from "./report-file.js";
import { spawnCommand } from "./spawn-command.js";
import { temporaryDir } from "./temporary-dir.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Node, tsx and the measuring children starting, then a short measurement, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** Windows has no signal a process can be sent and handle. */
const POSIX = process.platform !== "win32";

/** The fixture `name`, relative to the repository root the command starts in. */
function commandFixture(name: string): string {
  return `tests/fixtures/command/${name}`;
}

/** A fresh directory for a spawned command's report, removed when the test ends. */
function reportDir(): string {
  return temporaryDir("repset-command-e2e-");
}

describe("the command started as a process", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("exits 1 with the error in the result when a case throws", async () => {
    const out = join(reportDir(), "report.json");

    const { code } = await spawnCommand(ROOT, [
      commandFixture("throws.bench.ts"),
      "--node-import",
      "tsx",
      "--min-time",
      "1",
      "--out",
      out,
    ]);

    expect({
      code,
      errors: reportAt(out).results.map((result) => result.error?.message),
    }).toStrictEqual({ code: 1, errors: ["banana"] });
  });

  it.runIf(POSIX)("exits 130 on SIGINT, killing the running case", async () => {
    const out = join(reportDir(), "report.json");

    const { code } = await spawnCommand(
      ROOT,
      [
        commandFixture("sum.bench.ts"),
        "--node-import",
        "tsx",
        "--min-time",
        "600000",
        "--out",
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
