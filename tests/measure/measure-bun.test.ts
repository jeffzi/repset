import { spawnSync } from "node:child_process";
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

interface BunTestRun {
  readonly status: number | null;
  /** The JSON the test printed after `REPORT `, or `null` when it printed none. */
  readonly report: unknown;
}

/**
 * Runs `body` as one `bun test` case with `measure` and `MeasureError` imported, the benchmark of
 * {@link SCRIPT_BENCH} defined, a stub `gc`, a `loadFailure` object for a factory to throw, and
 * `bun:jsc` mocked by `bunJsc`: by default so that `received` holds every function its `noInline`
 * received.
 *
 * @param body - Statements of the async test case; one prints `REPORT ` followed by JSON.
 * @param bunJsc - The source of the factory `bun:jsc` is mocked with.
 * @returns How `bun test` exited and the parsed report.
 * @throws Error from the filesystem when the temporary directory or test file cannot be written.
 * @throws SyntaxError when the printed report is not valid JSON.
 */
function bunTestWithNoInlineMock(
  body: string,
  bunJsc = "() => ({ noInline: (fn) => { received.push(fn); } })",
): BunTestRun {
  const dir = temporaryDir("repset-bun-");
  const file = join(dir, "no-inline.test.ts");
  writeFileSync(
    file,
    `
import { mock, test } from "bun:test";
const received = [];
const loadFailure = { name: "durian" };
mock.module("bun:jsc", ${bunJsc});
globalThis.gc = () => {};
test("noInline", async () => {
  const { measure, MeasureError } = await import(${JSON.stringify(MEASURE_PATH)});
  ${SCRIPT_BENCH}
${body}
}, 50_000);
`,
  );

  const child = spawnSync("bun", ["test", file], { cwd: dir, encoding: "utf8" });

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
  observesGc: "gcDuringTiming" in result,
  sampleCount: result.sampleCount,
  sank: sink > 0,
}));
`;

      const child = spawnSync("bun", ["--expose-gc", "-e", script], { encoding: "utf8" });

      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toStrictEqual({
        observesGc: false,
        sampleCount: expect.any(Number),
        sank: true,
      });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "hands bun:jsc's noInline the body and exactly one other function",
    () => {
      const bun = bunTestWithNoInlineMock(`
  await measure({ kind: "sharedState", setup, fn });
  console.log("REPORT " + JSON.stringify({ fn: received.includes(fn), handed: received.length }));
`);

      expect(bun.status).toBe(0);
      expect(bun.report).toStrictEqual({ fn: true, handed: 2 });
    },
    BUN_TIMEOUT_MS,
  );

  it(
    "rejects in phase child with the loader's value as cause when bun:jsc cannot be loaded",
    () => {
      const bun = bunTestWithNoInlineMock(
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
