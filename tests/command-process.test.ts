import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Report } from "../src/report.js";
import { formatTable } from "../src/table.js";
import { requiresRealBunHere } from "./real-bun.js";
import { suiteTemporaryDir, temporaryDir } from "./temporary-dir.js";

/** Whether `value` is a schema-1 report document, checked on the keys the tests read. */
function isReport(value: unknown): value is Report {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === 1 &&
    "results" in value &&
    Array.isArray(value.results)
  );
}

/**
 * The report the file at `path` holds.
 *
 * @param path - The file the command wrote with `--out`.
 * @returns The parsed report.
 * @throws When the file is not JSON, or holds no schema-1 report.
 */
function reportAt(path: string): Report {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isReport(parsed)) throw new Error(`${path} does not hold a schema-1 report`);
  return parsed;
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Node, tsx and the measuring children starting, then short measurements, on a slow CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

/** Windows has no signal a process can be sent and handle. */
const POSIX = process.platform !== "win32";

/** The fixture `name`, relative to the repository root the command starts in. */
function commandFixture(name: string): string {
  return `tests/fixtures/command/${name}`;
}

/**
 * Starts the command from source on Node in the repository root.
 *
 * @param args - The command's arguments.
 * @param onStderr - Receives the command's stderr so far each time it grows, and a function that
 *   sends the command a signal the first time it is called.
 * @returns The exit code, or `null` when a signal ended the command, and what it printed.
 * @throws When the child emits `error`, as when its process cannot be started.
 */
async function spawnCommand(
  args: readonly string[],
  onStderr: (stderr: string, stop: (signal: NodeJS.Signals) => void) => void = () => {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stopSent = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onStderr(stderr, (signal) => {
      if (!stopSent) child.kill(signal);
      stopSent = true;
    });
  });
  const [code]: unknown[] = await once(child, "close");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
}

/** A fresh directory for a spawned command's report, removed when the test ends. */
function reportDir(): string {
  return temporaryDir("repset-command-e2e-");
}

describe("the command started as a process", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe.each([
    { runtime: "node", here: true },
    { runtime: "bun", here: requiresRealBunHere() },
  ])("on $runtime", ({ runtime, here }) => {
    describe.runIf(here)("running the sum fixture", () => {
      const dir = suiteTemporaryDir("repset-command-e2e-");
      let run!: { code: number | null; stdout: string; report: Report };

      beforeAll(async () => {
        const out = join(dir.path, "report.json");
        const { code, stdout } = await spawnCommand([
          commandFixture("sum.bench.ts"),
          "--runtime",
          runtime,
          "--node-import",
          "tsx",
          "--min-time",
          "1",
          "--out",
          out,
        ]);
        run = { code, stdout, report: reportAt(out) };
      }, SPAWN_TIMEOUT_MS);

      it("exits 0", () => {
        expect(run.code).toBe(0);
      });

      it("writes a schema-1 report with every case ok", () => {
        expect({
          schema: run.report.schema,
          ran: run.report.results.map((result) => [result.id, result.runtime.name, result.status]),
        }).toStrictEqual({
          schema: 1,
          ran: [
            ["sum/small", runtime, "ok"],
            ["sum/large", runtime, "ok"],
          ],
        });
      });

      it("prints the table of the report's results", () => {
        expect(run.stdout).toBe(formatTable(run.report.results));
      });
    });
  });

  it("exits 1 with the error in the result when a case throws", async () => {
    const out = join(reportDir(), "report.json");

    const { code } = await spawnCommand([
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
