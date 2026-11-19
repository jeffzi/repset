import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { requiresRealBunHere } from "../real-bun.js";
import { temporaryDir } from "../temporary-dir.js";

const MEASURE_PATH = fileURLToPath(new URL("../../src/measure/measure.ts", import.meta.url));

/** Bun starting, then a few real-clock measurements of about 1.25 s each, on a slow CI runner. */
const BUN_TIMEOUT_MS = 60_000;

/** A cheap shared-state benchmark well above the empty body's cost, as script source. */
const SCRIPT_BENCH = `
const values = Array.from({ length: 64 }, (_, index) => index);
let sink = 0;
const setup = () => ({ values });
const fn = (world) => { for (const value of world.values) sink += value; };
`;

/**
 * Runs `bun` with `args` to completion, killing it at {@link BUN_TIMEOUT_MS}.
 *
 * @param args - The arguments to `bun`.
 * @param cwd - The directory Bun starts in, this process's own when omitted.
 * @returns How Bun exited and what it printed.
 * @throws The spawn's own error, as when Bun cannot start or ran past its timeout.
 */
function runBun(args: readonly string[], cwd?: string): SpawnSyncReturns<string> {
  const child = spawnSync("bun", args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    timeout: BUN_TIMEOUT_MS,
  });
  if (child.error !== undefined) throw child.error;
  return child;
}

interface BunTestRun {
  readonly status: number | null;
  /** The JSON the test printed after `REPORT `, or `null` when it printed none. */
  readonly report: unknown;
}

/**
 * Runs `body` as one `bun test` case with `measure` and `MeasureError` imported, the benchmark of
 * {@link SCRIPT_BENCH} defined, a stub `gc`, a `loadFailure` object for a factory to throw, and
 * `bun:jsc` mocked by `bunJsc`.
 *
 * @param body - Statements of the async test case; one prints `REPORT ` followed by JSON.
 * @param bunJsc - The source of the factory `bun:jsc` is mocked with.
 * @returns How `bun test` exited and the parsed report.
 * @throws Error from the filesystem when the temporary directory or test file cannot be written.
 * @throws SyntaxError when the printed report is not valid JSON.
 * @throws The spawn's own error, as when Bun cannot start or ran past {@link BUN_TIMEOUT_MS}.
 */
function bunTestWithJscMock(body: string, bunJsc: string): BunTestRun {
  const dir = temporaryDir("repset-bun-");
  const file = join(dir, "jsc-mock.test.ts");
  writeFileSync(
    file,
    `
import { mock, test } from "bun:test";
const loadFailure = { name: "durian" };
mock.module("bun:jsc", ${bunJsc});
globalThis.gc = () => {};
test("jsc mock", async () => {
  const { measure, MeasureError } = await import(${JSON.stringify(MEASURE_PATH)});
  ${SCRIPT_BENCH}
${body}
}, 50_000);
`,
  );

  const child = runBun(["test", file], dir);

  const report = /REPORT (.*)/.exec(`${child.stdout}\n${child.stderr}`)?.[1];
  return { status: child.status, report: JSON.parse(report ?? "null") };
}

describe.runIf(requiresRealBunHere())("measure under real Bun", () => {
  it(
    "measures a shared-state benchmark with bun:jsc loaded, reporting no gc entries",
    () => {
      const script = `
const { measure } = await import(${JSON.stringify(MEASURE_PATH)});
${SCRIPT_BENCH}
const result = await measure({ kind: "sharedState", setup, fn });
console.log(JSON.stringify({
  observesGc: result.gc !== null,
  sank: sink > 0,
}));
`;

      const child = runBun(["--expose-gc", "-e", script]);

      // oxlint-disable-next-line vitest/valid-expect -- Vitest takes a failure message as expect's second argument
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toStrictEqual({
        observesGc: false,
        sank: true,
      });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "rejects in phase child with the loader's value as cause when bun:jsc cannot be loaded",
    () => {
      const bun = bunTestWithJscMock(
        `
  const error = await measure({ kind: "sharedState", setup, fn }).then(() => null, (e) => e);
  console.log("REPORT " + JSON.stringify({
    measureError: error instanceof MeasureError,
    phase: error?.phase,
    cause: error?.cause === loadFailure,
  }));
`,
        "() => { throw loadFailure; }",
      );

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ measureError: true, phase: "child", cause: true });
    },
    BUN_TIMEOUT_MS,
  );
});
