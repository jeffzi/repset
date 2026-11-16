/**
 * The overhead check: for each of eight cells it pairs one run of the built repset command with one
 * run of the hand-written loop in `overhead-check/plain-child.ts`, back to back, and judges the
 * pairs with `overhead-check/verdict.ts`.
 *
 *   node --import tsx scripts/overhead-check.ts
 *
 * It reads `dist/`, so build first. Nothing in it runs two children at once: the check is a
 * measurement, and a second process would move both readings.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SamplingReport } from "../src/child.js";
import type { Runtime } from "../src/measure/runtime.js";
import type { Report } from "../src/report.js";
import { thrownMessage } from "../src/utils.js";
import { BODY_NAMES, type BodyName } from "./overhead-check/bodies.js";
import {
  type CellSummary,
  type CellVerdict,
  exitStatus,
  judgeCell,
  type Pairs,
} from "./overhead-check/verdict.js";

/** One cell: a runtime, how its count is chosen, and the body both sides time. */
export interface Cell {
  readonly runtime: Runtime;
  /** `calibrated` lets warmup choose the count; `one-call` fixes it at one call per sample. */
  readonly count: "calibrated" | "one-call";
  readonly body: BodyName;
}

/** What one run of repset reports about its one process. */
export interface RepsetReading {
  /** Nanoseconds per call. */
  readonly median: number;
  readonly callsPerSample: number;
  readonly sampleCount: number;
  readonly timerResolutionNs: number;
  readonly timingMs: number;
  /** The report's `minTime`, which the calibrated-run rule holds timing to. */
  readonly minTime: number;
}

/** The counts a plain reading runs at, taken from a repset reading. */
export type PlainCounts = Pick<RepsetReading, "callsPerSample" | "sampleCount">;

/** The two sides of a pair: each takes one reading of a cell. */
export interface Readers {
  readonly repset: (cell: Cell) => RepsetReading | Promise<RepsetReading>;
  /** Returns the plain loop's median in nanoseconds per call. */
  readonly plain: (cell: Cell, counts: PlainCounts) => number | Promise<number>;
}

/** One round of a cell: its pairs, and the repset readings behind them in pair order. */
export interface Round {
  readonly pairs: Pairs;
  readonly readings: readonly RepsetReading[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const BENCH_FILE = "scripts/overhead-check/overhead.bench.ts";
const PLAIN_CHILD = join(ROOT, "scripts", "overhead-check", "plain-child.ts");

const PAIRS = 12;

/** The span, in timer resolutions, a calibrated reading's median timed sample reaches at least. */
const MIN_SPAN_RESOLUTIONS = 200;

const CALLS_VARIABLE = "REPSET_CALLS_PER_SAMPLE";

const RUNTIMES: readonly Runtime[] = ["node", "bun"];
const COUNTS: readonly Cell["count"][] = ["calibrated", "one-call"];

const CELLS: readonly Cell[] = RUNTIMES.flatMap((runtime) =>
  COUNTS.flatMap((count) => BODY_NAMES.map((body) => ({ runtime, count, body }))),
);

function cellName(cell: Cell): string {
  return `${cell.runtime} ${cell.count} ${cell.body}`;
}

function exitDescription(status: number | null): string {
  return status === null ? "was ended by a signal" : `exited ${String(status)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trusts the rest of the shape once `schema` names the format repset writes. */
function isReport(value: unknown): value is Report {
  return isRecord(value) && value["schema"] === 1 && Array.isArray(value["results"]);
}

/**
 * Builds the repset command line for one reading of `cell`.
 *
 * @param cell - The cell to read.
 * @param outPath - Where the command writes its report.
 * @param env - The environment to start from.
 * @returns The arguments to run under the driver's own Node, and the command's environment:
 *   `REPSET_CALLS_PER_SAMPLE=1` for a one-call cell, and the variable removed for a calibrated one.
 */
export function repsetCommand(
  cell: Cell,
  outPath: string,
  env: NodeJS.ProcessEnv,
): { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } {
  const { [CALLS_VARIABLE]: _inherited, ...rest } = env;
  return {
    args: [
      CLI,
      BENCH_FILE,
      "--runtime",
      cell.runtime,
      "--filter",
      `^overhead/${cell.body}$`,
      "--node-import",
      "tsx",
      "--out",
      outPath,
    ],
    env: cell.count === "one-call" ? { ...rest, [CALLS_VARIABLE]: "1" } : rest,
  };
}

/**
 * Checks a process's count against its cell: fixed at 1 for a one-call cell, calibrated otherwise.
 *
 * @param name - The cell's name.
 * @param cell - The cell the process read.
 * @param sampling - How the process sampled.
 * @throws Error naming the cell when the count does not match.
 */
function checkCount(name: string, cell: Cell, sampling: SamplingReport): void {
  const fixed = sampling.callsPerSampleFixed;
  const reported = `${String(sampling.callsPerSample)} ${fixed ? "fixed" : "calibrated"}`;
  if (cell.count === "one-call" && (!fixed || sampling.callsPerSample !== 1)) {
    throw new Error(`${name}: expected a count fixed at 1, the process reports ${reported}`);
  }
  if (cell.count === "calibrated" && fixed) {
    throw new Error(`${name}: expected a calibrated count, the process reports ${reported}`);
  }
}

/**
 * Reads the report one run of the repset command wrote, and its one result.
 *
 * @param name - The cell's name.
 * @param reportPath - The file the command wrote its report to.
 * @returns The report and the one result it holds.
 * @throws Error naming the cell when the report is missing, unreadable or not a report holding
 *   exactly one result.
 */
function onlyResult(
  name: string,
  reportPath: string,
): { readonly report: Report; readonly result: Report["results"][number] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`${name}: cannot read the report ${reportPath}: ${thrownMessage(error)}`, {
      cause: error,
    });
  }
  const result = isReport(parsed) && parsed.results.length === 1 ? parsed.results[0] : undefined;
  if (!isReport(parsed) || result === undefined) {
    throw new Error(`${name}: ${reportPath} is not a report holding exactly one result`);
  }
  return { report: parsed, result };
}

/**
 * Turns one run of the repset command into a reading, refusing one the check cannot trust.
 *
 * @param cell - The cell the run read.
 * @param status - The command's exit status, `null` when a signal ended it.
 * @param reportPath - The file the command wrote its report to.
 * @returns The result's process: its median, counts, timer resolution and timing length, with the
 *   report's `minTime`.
 * @throws Error naming the cell when the command exited non-zero; the report is missing, unreadable
 *   or not a report holding exactly one measured result; the result failed, naming its phase and
 *   message; or the process's count does not match the cell's.
 */
export function repsetReading(
  cell: Cell,
  status: number | null,
  reportPath: string,
): RepsetReading {
  const name = cellName(cell);
  if (status !== 0) throw new Error(`${name}: repset ${exitDescription(status)}`);
  const { report, result } = onlyResult(name, reportPath);
  if (result.status === "failed") {
    throw new Error(
      `${name}: the case failed in phase ${result.error.phase}: ${result.error.message}`,
    );
  }
  const { stats, sampling } = result.processes[0] ?? {};
  if (stats == null || sampling == null) {
    throw new Error(`${name}: the result holds no measured process`);
  }
  checkCount(name, cell, sampling);
  return {
    median: stats.median,
    callsPerSample: sampling.callsPerSample,
    sampleCount: stats.sampleCount,
    timerResolutionNs: sampling.timerResolutionNs,
    timingMs: sampling.timingMs,
    minTime: report.options.minTime,
  };
}

/**
 * Checks one run of the plain child.
 *
 * @param cell - The cell the run read.
 * @param status - The child's exit status, `null` when a signal ended it.
 * @param stdout - What the child printed: its `{"median": <ns per call>}` line.
 * @returns The median the child printed.
 * @throws Error naming the cell when the child exited non-zero or printed no finite median.
 */
export function checkedPlainMedian(cell: Cell, status: number | null, stdout: string): number {
  const name = cellName(cell);
  if (status !== 0) throw new Error(`${name}: the plain child ${exitDescription(status)}`);
  const median = printedMedian(stdout);
  if (!Number.isFinite(median)) {
    throw new Error(`${name}: the plain child printed no finite median`);
  }
  return median;
}

/** Reads the median from the plain child's `{"median": <ns per call>}` line, `NaN` when absent. */
function printedMedian(stdout: string): number {
  try {
    const printed: unknown = JSON.parse(stdout);
    return isRecord(printed) && typeof printed["median"] === "number"
      ? printed["median"]
      : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * Throws a spawn failure, such as a missing executable, as an error naming the cell.
 *
 * @param cell - The cell the run read.
 * @param error - The error `spawnSync` reported, if any.
 * @throws Error naming the cell when `error` is set.
 */
function throwSpawnError(cell: Cell, error: Error | undefined): void {
  if (error !== undefined) {
    throw new Error(`${cellName(cell)}: cannot start the child: ${error.message}`, {
      cause: error,
    });
  }
}

function readRepset(cell: Cell): RepsetReading {
  const dir = mkdtempSync(join(tmpdir(), "overhead-check-"));
  try {
    const outPath = join(dir, "report.json");
    const command = repsetCommand(cell, outPath, process.env);
    const run = spawnSync(process.execPath, command.args, {
      cwd: ROOT,
      env: command.env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    throwSpawnError(cell, run.error);
    return repsetReading(cell, run.status, outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the plain child's command line for one reading of `cell`.
 *
 * @param cell - The cell to read.
 * @param counts - The calls per sample and sample count to run at.
 * @returns The driver's own Node with tsx for a Node cell, or the `bun` on `PATH` for a Bun cell,
 *   as repset's children run, and the arguments: the body, then the two counts.
 */
export function plainCommand(
  cell: Cell,
  counts: PlainCounts,
): { readonly executable: string; readonly args: readonly string[] } {
  const [executable, runtimeArgs] =
    cell.runtime === "node" ? [process.execPath, ["--import", "tsx"]] : ["bun", []];
  return {
    executable,
    args: [
      ...runtimeArgs,
      "--expose-gc",
      PLAIN_CHILD,
      cell.body,
      String(counts.callsPerSample),
      String(counts.sampleCount),
    ],
  };
}

function readPlain(cell: Cell, counts: PlainCounts): number {
  const { executable, args } = plainCommand(cell, counts);
  const run = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  throwSpawnError(cell, run.error);
  return checkedPlainMedian(cell, run.status, run.stdout);
}

const REAL_READERS: Readers = { repset: readRepset, plain: readPlain };

function countsOf(reading: RepsetReading): PlainCounts {
  return { callsPerSample: reading.callsPerSample, sampleCount: reading.sampleCount };
}

/**
 * Takes one round of a cell: twelve pairs, back to back.
 *
 * The first pair runs repset first and the pairs then alternate. A pair that runs the plain loop
 * first runs it at the previous pair's repset counts, the latest there are.
 *
 * @param cell - The cell to read.
 * @param readers - The two sides' readers.
 * @returns The round's pairs, `plain[i]` and `repset[i]` from pair `i`, and its repset readings.
 * @throws Whatever a reader throws.
 */
export async function takeRound(cell: Cell, readers: Readers): Promise<Round> {
  const plain: number[] = [];
  const readings: RepsetReading[] = [];
  let latest: RepsetReading | undefined;
  for (let pair = 0; pair < PAIRS; pair += 1) {
    if (latest === undefined || pair % 2 === 0) {
      latest = await readers.repset(cell);
      readings.push(latest);
      plain.push(await readers.plain(cell, countsOf(latest)));
    } else {
      plain.push(await readers.plain(cell, countsOf(latest)));
      latest = await readers.repset(cell);
      readings.push(latest);
    }
  }
  return { pairs: { plain, repset: readings.map((reading) => reading.median) }, readings };
}

/** The median timed sample's span in timer resolutions: the median per call times the count. */
function spanInResolutions(reading: RepsetReading): number {
  return (reading.median * reading.callsPerSample) / reading.timerResolutionNs;
}

function formatGap(gap: number): string {
  return `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(2)}%`;
}

function summaryLine(name: string, label: string, summary: CellSummary): string {
  return `${name}  ${label} round  plain ${summary.plainMedian.toFixed(1)} ns  repset ${summary.repsetMedian.toFixed(1)} ns  gap ${formatGap(summary.gap)}  p=${summary.pValue.toFixed(4)}`;
}

/**
 * Lists the readings of a calibrated cell that break the calibrated-run rule.
 *
 * @param name - The cell's name.
 * @param rounds - The cell's rounds: the first, then the fresh one when it was taken.
 * @returns One line per broken bound, naming the round, the pair's number in it and the value.
 */
function ruleBreaks(name: string, rounds: readonly Round[]): string[] {
  return rounds.flatMap((round, roundIndex) =>
    round.readings.flatMap((reading, index) => {
      const where = `${name}  ${roundIndex === 0 ? "first" : "fresh"} round, pair ${String(index + 1)}:`;
      const span = spanInResolutions(reading);
      const breaks: string[] = [];
      if (span < MIN_SPAN_RESOLUTIONS) {
        breaks.push(
          `${where} median sample spans ${span.toFixed(1)} resolutions, under ${String(MIN_SPAN_RESOLUTIONS)}`,
        );
      }
      if (reading.timingMs < reading.minTime) {
        breaks.push(
          `${where} timing lasted ${reading.timingMs.toFixed(1)} ms, under minTime ${String(reading.minTime)} ms`,
        );
      }
      return breaks;
    }),
  );
}

/**
 * Lays out what the check prints for one judged cell.
 *
 * @param cell - The cell.
 * @param verdict - The cell's verdict.
 * @param rounds - The cell's rounds: the first, then the fresh one when it was taken.
 * @returns The lines to print, and the lines of readings that broke the calibrated-run rule.
 */
function cellReport(
  cell: Cell,
  verdict: CellVerdict,
  rounds: readonly Round[],
): { readonly lines: readonly string[]; readonly breaks: readonly string[] } {
  const name = cellName(cell);
  const lines = [summaryLine(name, "first", verdict.first)];
  if (verdict.confirmation !== undefined) {
    lines.push(summaryLine(name, "fresh", verdict.confirmation));
  }
  const outcome = `${name}  ${verdict.passed ? "pass" : "FAIL"}`;
  if (cell.count === "one-call") {
    lines.push(outcome);
    return { lines, breaks: [] };
  }
  const readings = rounds.flatMap((round) => round.readings);
  const smallestSpan = Math.min(...readings.map(spanInResolutions));
  const shortestTiming = Math.min(...readings.map((reading) => reading.timingMs));
  lines.push(
    `${name}  smallest span ${smallestSpan.toFixed(1)} resolutions  shortest timing ${shortestTiming.toFixed(1)} ms`,
  );
  const breaks = ruleBreaks(name, rounds);
  lines.push(...breaks, outcome);
  return { lines, breaks };
}

/**
 * Runs the overhead check over every cell, one reading at a time, printing each cell once judged.
 *
 * @param readers - The two sides' readers; the real ones run `dist/cli.js` and the plain child.
 * @param print - Where each cell's lines go.
 * @returns 1 when any cell failed or any calibrated reading broke the calibrated-run rule, 0
 *   otherwise.
 * @throws Error naming the cell when a reading cannot be trusted, and whatever `print` throws.
 */
export async function runCheck(
  readers: Readers = REAL_READERS,
  print: (text: string) => void = console.log,
): Promise<0 | 1> {
  const verdicts: CellVerdict[] = [];
  let broken = false;
  for (const cell of CELLS) {
    const first = await takeRound(cell, readers);
    const rounds = [first];
    const verdict = await judgeCell(first.pairs, async () => {
      const fresh = await takeRound(cell, readers);
      rounds.push(fresh);
      return fresh.pairs;
    });
    verdicts.push(verdict);
    const report = cellReport(cell, verdict, rounds);
    broken ||= report.breaks.length > 0;
    print(report.lines.join("\n"));
  }
  return broken ? 1 : exitStatus(verdicts);
}

if (import.meta.main) {
  process.exitCode = await runCheck();
}
