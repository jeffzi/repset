/**
 * The overhead check: for each scenario, one per runtime, count mode and body, it pairs one run of
 * the built repset command with one run of the baseline loop in `check-overhead/baseline-child.ts`,
 * back to back, and judges the pairs with `check-overhead/verdict.ts`.
 *
 *   node --import tsx scripts/check-overhead.ts
 *
 * It reads `dist/`, so build first. Nothing in it runs two children at once: the check is a
 * measurement, and a second process would move both readings.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SamplingReport } from "../src/child.js";
import { childRuntimeFlags, findRuntime, howItEnded } from "../src/children.js";
import { CALLS_PER_SAMPLE } from "../src/command-line.js";
import { RUNTIMES, type Runtime } from "../src/measure/runtime.js";
import { DEFAULT_TIMEOUT } from "../src/options.js";
import type { FailedResult, Report } from "../src/report.js";
import { isRecord, property, thrownMessage, valueAt } from "../src/utils.js";
import { BODY_NAMES, type BodyName } from "./check-overhead/bodies.js";
import {
  judgeScenario,
  type Pairs,
  type RoundSummary,
  type ScenarioVerdict,
} from "./check-overhead/verdict.js";

// ---------------------------------------------------------------------------
// Scenarios, readings and constants
// ---------------------------------------------------------------------------

/** One scenario: a runtime, how its count is chosen, and the body both sides time. */
export interface Scenario {
  readonly runtime: Runtime;
  /** `calibrated` lets warmup choose the count; `one-call` fixes it at one call per sample. */
  readonly countMode: "calibrated" | "one-call";
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
  /** The report's `minTime`, which a calibrated reading's timing must last at least. */
  readonly minTime: number;
}

/** The counts a baseline reading runs at, taken from a repset reading. */
export type BaselineCounts = Pick<RepsetReading, "callsPerSample" | "sampleCount">;

/** The two sides of a pair: each takes one reading of a scenario. */
export interface Readers {
  readonly repset: (scenario: Scenario) => RepsetReading;
  /** Returns the baseline loop's median in nanoseconds per call. */
  readonly baseline: (scenario: Scenario, counts: BaselineCounts) => number;
}

/** How one spawned run ended: its exit status, or the signal that killed it. */
type RunEnd = Pick<SpawnSyncReturns<string>, "status" | "signal">;

/** One round of a scenario: its pairs, and the repset readings behind them in pair order. */
interface Round {
  readonly pairs: Pairs;
  readonly readings: readonly RepsetReading[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const BENCH_FILE = "scripts/check-overhead/overhead.bench.ts";
const BASELINE_CHILD = join(ROOT, "scripts", "check-overhead", "baseline-child.ts");

const PAIRS = 12;

const REPORT_SCHEMA: Report["schema"] = 1;

const COUNT_MODES: readonly Scenario["countMode"][] = ["calibrated", "one-call"];

const SCENARIOS: readonly Scenario[] = RUNTIMES.flatMap((runtime) =>
  COUNT_MODES.flatMap((countMode) => BODY_NAMES.map((body) => ({ runtime, countMode, body }))),
);

function scenarioName(scenario: Scenario): string {
  return `${scenario.runtime} ${scenario.countMode} ${scenario.body}`;
}

// ---------------------------------------------------------------------------
// Reading repset and the baseline
// ---------------------------------------------------------------------------

/**
 * Says how a run that did not end cleanly ended.
 *
 * @param subject - What ran, as the sentence's subject.
 * @param end - The run's exit status and signal.
 * @returns `<subject> was killed by <signal>`, or `<subject> exited with status <status>`.
 */
function howRunEnded(subject: string, end: RunEnd): string {
  return howItEnded(subject, { kind: "exit", code: end.status, signal: end.signal });
}

/**
 * Reads the failed result a run that exited 1 left in its report.
 *
 * @param reportPath - The file the command wrote its report to.
 * @returns The report's first failed result, or `undefined` when the file is missing, unreadable,
 *   not a report, or holds no failed result.
 */
function failedResult(reportPath: string): FailedResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isReport(parsed)) return undefined;
  return parsed.results.find((result): result is FailedResult => result.status === "failed");
}

/** The message saying `failed`'s case failed, naming the scenario `name`, the phase and the error. */
function caseFailure(name: string, failed: FailedResult): string {
  return `${name}: the case failed in phase ${failed.error.phase}: ${failed.error.message}`;
}

/**
 * Checks that `value` is a report, trusting the rest of its shape once `schema` names the format
 * repset writes.
 *
 * @param value - The parsed report file.
 * @returns Whether `value` has repset's `schema` and a `results` array, which narrows it to
 *   `Report`.
 */
function isReport(value: unknown): value is Report {
  return isRecord(value) && value["schema"] === REPORT_SCHEMA && Array.isArray(value["results"]);
}

/**
 * Checks a process's count against its scenario: fixed at 1 for a one-call scenario, calibrated
 * otherwise.
 *
 * @param name - The scenario's name.
 * @param scenario - The scenario the process read.
 * @param sampling - How the process sampled.
 * @throws Error naming the scenario when the count does not match.
 */
function checkCount(name: string, scenario: Scenario, sampling: SamplingReport): void {
  const fixed = sampling.callsPerSampleFixed;
  const reported = `${String(sampling.callsPerSample)} ${fixed ? "fixed" : "calibrated"}`;
  if (scenario.countMode === "one-call" && (!fixed || sampling.callsPerSample !== 1)) {
    throw new Error(`${name}: expected a count fixed at 1, the process reports ${reported}`);
  }
  if (scenario.countMode === "calibrated" && fixed) {
    throw new Error(`${name}: expected a calibrated count, the process reports ${reported}`);
  }
}

/**
 * Reads the report one run of the repset command wrote, and its one result.
 *
 * @param name - The scenario's name.
 * @param reportPath - The file the command wrote its report to.
 * @returns The report and the one result it holds.
 * @throws Error naming the scenario when the report is missing, unreadable or not a report holding
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
 * @param scenario - The scenario the run read.
 * @param end - The command's exit status and the signal that killed it.
 * @param reportPath - The file the command wrote its report to.
 * @returns The result's process: its median, counts, timer resolution and timing length, with the
 *   report's `minTime`.
 * @throws Error naming the scenario when the case failed, naming its phase and message: the
 *   command exited 1 and its report holds a failed result, or exited 0 with a failed result.
 * @throws Error naming the scenario and how the command ended when it ended otherwise than with
 *   status 0.
 * @throws Error naming the scenario when the report of a run that exited 0 is missing, unreadable
 *   or not a report holding exactly one result, or the process's count does not match the
 *   scenario's.
 */
export function repsetReading(scenario: Scenario, end: RunEnd, reportPath: string): RepsetReading {
  const name = scenarioName(scenario);
  if (end.status !== 0) {
    // repset exits 1 when a case fails, and its report then says why.
    const failed = end.status === 1 ? failedResult(reportPath) : undefined;
    throw new Error(
      failed === undefined ? howRunEnded(`${name}: repset`, end) : caseFailure(name, failed),
    );
  }
  const { report, result } = onlyResult(name, reportPath);
  if (result.status === "failed") throw new Error(caseFailure(name, result));
  const { stats, sampling } = result.processes[0];
  checkCount(name, scenario, sampling);
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
 * Checks one run of the baseline child and reads the median from its `{"median": <ns per call>}`
 * line.
 *
 * @param scenario - The scenario the run read.
 * @param end - The child's exit status and the signal that killed it.
 * @param stdout - What the child printed.
 * @returns The median the child printed, in nanoseconds per call.
 * @throws Error naming the scenario and how the child ended when it exited non-zero or a signal
 *   killed it.
 * @throws Error naming the scenario when the child printed something that is not JSON or holds no
 *   finite numeric median.
 */
export function checkedBaselineMedian(scenario: Scenario, end: RunEnd, stdout: string): number {
  const name = scenarioName(scenario);
  if (end.status !== 0) throw new Error(howRunEnded(`${name}: the baseline child`, end));
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    printed = undefined;
  }
  const median = property(printed, "median");
  if (typeof median !== "number" || !Number.isFinite(median)) {
    throw new Error(`${name}: the baseline child printed no finite median`);
  }
  return median;
}

/**
 * Throws a spawn failure, such as a missing executable, as an error naming the scenario.
 *
 * @param scenario - The scenario the run read.
 * @param error - The error `spawnSync` reported, if any.
 * @throws Error naming the scenario when `error` is set.
 */
function throwSpawnError(scenario: Scenario, error: Error | undefined): void {
  if (error !== undefined) {
    throw new Error(`${scenarioName(scenario)}: cannot start the child: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Runs the repset command once on `scenario` under the driver's own Node, with
 * `REPSET_CALLS_PER_SAMPLE=1` for a one-call scenario and the variable removed for a calibrated one,
 * and reads its report from a temporary directory it removes afterwards.
 *
 * @param scenario - The scenario to read.
 * @returns The reading of the scenario's one result.
 * @throws Error naming the scenario when the command cannot start or its run cannot be trusted
 *   (see {@link repsetReading}).
 * @throws The filesystem error from creating or removing the temporary directory.
 */
function readRepset(scenario: Scenario): RepsetReading {
  const dir = mkdtempSync(join(tmpdir(), "check-overhead-"));
  try {
    const outPath = join(dir, "report.json");
    const { [CALLS_PER_SAMPLE]: _inherited, ...env } = process.env;
    const args = [
      CLI,
      BENCH_FILE,
      "--runtime",
      scenario.runtime,
      "--filter",
      `^overhead/${scenario.body}$`,
      "--node-import",
      "tsx",
      "--output",
      outPath,
    ];
    const run = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env: scenario.countMode === "one-call" ? { ...env, [CALLS_PER_SAMPLE]: "1" } : env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    throwSpawnError(scenario, run.error);
    return repsetReading(scenario, run, outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The executable each runtime's children start on. */
type Executables = Readonly<Record<Runtime, string>>;

/**
 * Finds each runtime's executable with repset's own lookup, so the baseline child of a scenario
 * runs on the executable repset's children run on.
 *
 * @returns Each runtime's executable.
 * @throws The `ConfigError` `findRuntime` throws when a runtime's executable is not on `PATH` or
 *   its version probe fails or runs past the default timeout a repset run gets.
 * @throws Error When `process.versions` holds no version for the runtime this process runs on.
 */
async function findExecutables(): Promise<Executables> {
  const lookup = { timeout: DEFAULT_TIMEOUT };
  const [node, bun] = await Promise.all([findRuntime("node", lookup), findRuntime("bun", lookup)]);
  return { node: node.executable, bun: bun.executable };
}

/**
 * Runs the baseline child once on `scenario`'s runtime executable, started with the flags repset's
 * own children start with (Node loading tsx to run TypeScript), and reads its median.
 *
 * @param executables - Each runtime's executable.
 * @param scenario - The scenario to read.
 * @param counts - The calls per sample and sample count to run at.
 * @returns The median the child printed, in nanoseconds per call.
 * @throws Error naming the scenario when the child cannot start, ends badly or prints no finite
 *   median.
 */
function readBaseline(
  executables: Executables,
  scenario: Scenario,
  counts: BaselineCounts,
): number {
  const args = [
    ...childRuntimeFlags(scenario.runtime, "tsx"),
    BASELINE_CHILD,
    scenario.body,
    String(counts.callsPerSample),
    String(counts.sampleCount),
  ];
  const run = spawnSync(executables[scenario.runtime], args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  throwSpawnError(scenario, run.error);
  return checkedBaselineMedian(scenario, run, run.stdout);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * Takes one round of a scenario: {@link PAIRS} pairs, back to back.
 *
 * The first pair runs repset first and the pairs then alternate. A pair that runs the baseline
 * loop first runs it at the previous pair's repset counts, the latest there are.
 *
 * A pair's per-call resolution is its repset reading's timer resolution divided by the fewer calls
 * per sample of its two readings: the coarser of the two sides' per-call resolutions, so a tie on
 * either side stays a tie.
 *
 * @param scenario - The scenario to read.
 * @param readers - The two sides' readers.
 * @returns The round's pairs, `baseline[i]`, `repset[i]` and `perCallResolutions[i]` from pair
 *   `i`, and its repset readings.
 * @throws Whatever a reader throws.
 */
function takeRound(scenario: Scenario, readers: Readers): Round {
  const baseline: number[] = [];
  const perCallResolutions: number[] = [];
  const readings: RepsetReading[] = [];
  let latest: RepsetReading | undefined;
  for (let pair = 0; pair < PAIRS; pair += 1) {
    let baselineCounts: BaselineCounts;
    if (latest === undefined || pair % 2 === 0) {
      latest = readers.repset(scenario);
      baselineCounts = latest;
      baseline.push(readers.baseline(scenario, baselineCounts));
    } else {
      baselineCounts = latest;
      baseline.push(readers.baseline(scenario, baselineCounts));
      latest = readers.repset(scenario);
    }
    readings.push(latest);
    perCallResolutions.push(
      latest.timerResolutionNs / Math.min(latest.callsPerSample, baselineCounts.callsPerSample),
    );
  }
  return {
    pairs: { baseline, repset: readings.map((reading) => reading.median), perCallResolutions },
    readings,
  };
}

// ---------------------------------------------------------------------------
// Report layout
// ---------------------------------------------------------------------------

/**
 * Formats a number with two decimals and an explicit sign.
 *
 * @param value - The number to format.
 * @returns `value` with two decimals, prefixed `+` when it is zero or positive.
 */
function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function roundLabel(roundIndex: number): string {
  return roundIndex === 0 ? "first" : "confirmation";
}

function pairPlace(name: string, roundIndex: number, pairIndex: number): string {
  return `${name}  ${roundLabel(roundIndex)} round, pair ${String(pairIndex + 1)}:`;
}

function summaryLine(name: string, roundIndex: number, summary: RoundSummary): string {
  return `${name}  ${roundLabel(roundIndex)} round  baseline ${summary.baselineMedian.toFixed(1)} ns  repset ${summary.repsetMedian.toFixed(1)} ns  gap ${formatSigned(summary.gap * 100)}%  mean diff ${formatSigned(summary.meanDifference)} ns  p=${summary.pValue.toFixed(4)}`;
}

/**
 * Lays out one round: its summary line, then one line per pair with both medians at full precision.
 *
 * @param name - The scenario's name.
 * @param roundIndex - The round's index among the scenario's rounds: 0 for the first, 1 for the
 *   confirmation.
 * @param summary - The verdict's summary of the round.
 * @param pairs - The round's pairs.
 * @returns The summary line, then the pair lines in pair order.
 * @throws RangeError when `pairs.repset` is shorter than `pairs.baseline`.
 */
function roundLines(
  name: string,
  roundIndex: number,
  summary: RoundSummary,
  pairs: Pairs,
): string[] {
  const pairLines = pairs.baseline.map((baseline, pairIndex) => {
    const repset = valueAt(pairs.repset, pairIndex);
    return `${pairPlace(name, roundIndex, pairIndex)}  baseline ${String(baseline)}  repset ${String(repset)}`;
  });
  return [summaryLine(name, roundIndex, summary), ...pairLines];
}

/**
 * Lists the readings of a calibrated scenario whose timing lasted under `minTime`.
 *
 * The sampler already keeps a calibrated run only when its upper median sample, rounded to whole
 * resolutions, reaches the span floor, and fails the case otherwise, so the check does not judge
 * that floor again: the report's interpolated median cannot reproduce the value the sampler judged.
 *
 * @param name - The scenario's name.
 * @param rounds - The scenario's rounds: the first, then the confirmation one when it was taken.
 * @returns One line per reading under `minTime`, naming the round, the pair's number in it and the
 *   value.
 */
function floorBreaks(name: string, rounds: readonly Round[]): string[] {
  return rounds.flatMap((round, roundIndex) =>
    round.readings.flatMap((reading, index) =>
      reading.timingMs < reading.minTime
        ? [
            `${pairPlace(name, roundIndex, index)} timing lasted ${reading.timingMs.toFixed(1)} ms, under minTime ${String(reading.minTime)} ms`,
          ]
        : [],
    ),
  );
}

/**
 * Lays out what the check prints for one judged scenario.
 *
 * @param scenario - The scenario.
 * @param verdict - The scenario's verdict.
 * @param rounds - The scenario's rounds: the first, then the confirmation one when it was taken.
 * @returns The lines to print, and the lines of calibrated readings whose timing lasted under
 *   `minTime`.
 * @throws Error when a confirmation round was taken but the verdict holds no confirmation summary,
 *   and RangeError when a round holds fewer repset medians than baseline ones.
 */
function scenarioReport(
  scenario: Scenario,
  verdict: ScenarioVerdict,
  rounds: readonly Round[],
): { readonly lines: readonly string[]; readonly floorBreaks: readonly string[] } {
  const name = scenarioName(scenario);
  const lines = rounds.flatMap((round, roundIndex) => {
    const summary = roundIndex === 0 ? verdict.first : verdict.confirmation;
    if (summary === undefined) {
      throw new Error(`${name}: the confirmation round has no confirmation summary`);
    }
    return roundLines(name, roundIndex, summary, round.pairs);
  });
  const outcome = `${name}  ${verdict.passed ? "pass" : "FAIL"}`;
  if (scenario.countMode === "one-call") {
    lines.push(outcome);
    return { lines, floorBreaks: [] };
  }
  const readings = rounds.flatMap((round) => round.readings);
  const shortestTiming = Math.min(...readings.map((reading) => reading.timingMs));
  lines.push(`${name}  shortest timing ${shortestTiming.toFixed(1)} ms`);
  const breaks = floorBreaks(name, rounds);
  lines.push(...breaks, outcome);
  return { lines, floorBreaks: breaks };
}

// ---------------------------------------------------------------------------
// Running the check
// ---------------------------------------------------------------------------

/**
 * Runs the overhead check over every scenario, one reading at a time, printing each once judged.
 *
 * @param readers - The two sides' readers; the real ones run `dist/cli.js` and the baseline child.
 * @param print - Where each scenario's lines go.
 * @returns 1 when any scenario failed or any calibrated reading's timing lasted under `minTime`, 0
 *   otherwise.
 * @throws Error naming the scenario when a reading cannot be trusted; the real repset reader's
 *   filesystem errors from creating or removing its temporary directory, which name no scenario;
 *   whatever a caller-supplied reader throws; and whatever `print` throws.
 */
export function runCheck(readers: Readers, print: (text: string) => void = console.log): 0 | 1 {
  let failed = false;
  for (const scenario of SCENARIOS) {
    const first = takeRound(scenario, readers);
    const rounds = [first];
    const verdict = judgeScenario(first.pairs, () => {
      const confirmation = takeRound(scenario, readers);
      rounds.push(confirmation);
      return confirmation.pairs;
    });
    const report = scenarioReport(scenario, verdict, rounds);
    failed ||= !verdict.passed || report.floorBreaks.length > 0;
    print(report.lines.join("\n"));
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const executables = await findExecutables();
  process.exitCode = runCheck({
    repset: readRepset,
    baseline: (scenario, counts) => readBaseline(executables, scenario, counts),
  });
}
