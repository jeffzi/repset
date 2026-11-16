/**
 * The overhead check: for each of eight scenarios it pairs one run of the built repset command with
 * one run of the baseline loop in `check-overhead/baseline-child.ts`, back to back, and judges the
 * pairs with `check-overhead/verdict.ts`.
 *
 *   node --import tsx scripts/check-overhead.ts
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
import { CALLS_PER_SAMPLE } from "../src/command.js";
import { RUNTIMES, type Runtime } from "../src/measure/runtime.js";
import { MIN_RESOLUTIONS_PER_SAMPLE } from "../src/measure/sampler.js";
import type { Report } from "../src/report.js";
import { isRecord, thrownMessage } from "../src/utils.js";
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
  /** The report's `minTime`, which the timing floors hold timing to. */
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

function exitDescription(status: number | null): string {
  return status === null ? "was ended by a signal" : `exited ${String(status)}`;
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
  return isRecord(value) && value["schema"] === 1 && Array.isArray(value["results"]);
}

/**
 * Builds the repset command line for one reading of `scenario`.
 *
 * @param scenario - The scenario to read.
 * @param outPath - Where the command writes its report.
 * @param env - The environment to start from.
 * @returns The arguments to run under the driver's own Node, and the command's environment:
 *   `REPSET_CALLS_PER_SAMPLE=1` for a one-call scenario, and the variable removed for a calibrated
 *   one.
 */
function repsetCommand(
  scenario: Scenario,
  outPath: string,
  env: NodeJS.ProcessEnv,
): { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } {
  const { [CALLS_PER_SAMPLE]: _inherited, ...rest } = env;
  return {
    args: [
      CLI,
      BENCH_FILE,
      "--runtime",
      scenario.runtime,
      "--filter",
      `^overhead/${scenario.body}$`,
      "--node-import",
      "tsx",
      "--out",
      outPath,
    ],
    env: scenario.countMode === "one-call" ? { ...rest, [CALLS_PER_SAMPLE]: "1" } : rest,
  };
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
 * @param status - The command's exit status, `null` when a signal ended it.
 * @param reportPath - The file the command wrote its report to.
 * @returns The result's process: its median, counts, timer resolution and timing length, with the
 *   report's `minTime`.
 * @throws Error naming the scenario when the command exited non-zero; the report is missing,
 *   unreadable or not a report holding exactly one measured result; the result failed, naming its
 *   phase and message; or the process's count does not match the scenario's.
 */
function repsetReading(
  scenario: Scenario,
  status: number | null,
  reportPath: string,
): RepsetReading {
  const name = scenarioName(scenario);
  if (status !== 0) throw new Error(`${name}: repset ${exitDescription(status)}`);
  const { report, result } = onlyResult(name, reportPath);
  if (result.status === "failed") {
    throw new Error(
      `${name}: the case failed in phase ${result.error.phase}: ${result.error.message}`,
    );
  }
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
 * @param status - The child's exit status, `null` when a signal ended it.
 * @param stdout - What the child printed.
 * @returns The median the child printed, in nanoseconds per call.
 * @throws Error naming the scenario when the child exited non-zero, or printed something that is
 *   not JSON or holds no finite numeric median.
 */
function checkedBaselineMedian(scenario: Scenario, status: number | null, stdout: string): number {
  const name = scenarioName(scenario);
  if (status !== 0) throw new Error(`${name}: the baseline child ${exitDescription(status)}`);
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    printed = undefined;
  }
  const median = isRecord(printed) ? printed["median"] : undefined;
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

function readRepset(scenario: Scenario): RepsetReading {
  const dir = mkdtempSync(join(tmpdir(), "check-overhead-"));
  try {
    const outPath = join(dir, "report.json");
    const command = repsetCommand(scenario, outPath, process.env);
    const run = spawnSync(process.execPath, command.args, {
      cwd: ROOT,
      env: command.env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    throwSpawnError(scenario, run.error);
    return repsetReading(scenario, run.status, outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUNTIME_COMMANDS: Readonly<Record<Runtime, readonly [string, readonly string[]]>> = {
  node: [process.execPath, ["--import", "tsx"]],
  bun: ["bun", []],
};

/**
 * Builds the baseline child's command line for one reading of `scenario`.
 *
 * @param scenario - The scenario to read.
 * @param counts - The calls per sample and sample count to run at.
 * @returns The driver's own Node with tsx for a Node scenario, or the `bun` on `PATH` for a Bun
 *   scenario, as repset's children run, and the arguments: the body, then the two counts.
 */
function baselineCommand(
  scenario: Scenario,
  counts: BaselineCounts,
): { readonly executable: string; readonly args: readonly string[] } {
  const [executable, runtimeArgs] = RUNTIME_COMMANDS[scenario.runtime];
  return {
    executable,
    args: [
      ...runtimeArgs,
      "--expose-gc",
      BASELINE_CHILD,
      scenario.body,
      String(counts.callsPerSample),
      String(counts.sampleCount),
    ],
  };
}

function readBaseline(scenario: Scenario, counts: BaselineCounts): number {
  const { executable, args } = baselineCommand(scenario, counts);
  const run = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  throwSpawnError(scenario, run.error);
  return checkedBaselineMedian(scenario, run.status, run.stdout);
}

const REAL_READERS: Readers = { repset: readRepset, baseline: readBaseline };

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * Takes one round of a scenario: twelve pairs, back to back.
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
 * Measures the span of a reading's median timed sample.
 *
 * @param reading - The repset reading.
 * @returns The span in timer resolutions: the median per call times the count, over the timer
 *   resolution.
 */
function spanInResolutions(reading: RepsetReading): number {
  return (reading.median * reading.callsPerSample) / reading.timerResolutionNs;
}

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
    const repset = pairs.repset[pairIndex];
    if (repset === undefined) {
      throw new RangeError(`${pairPlace(name, roundIndex, pairIndex)} no repset median`);
    }
    return `${pairPlace(name, roundIndex, pairIndex)}  baseline ${String(baseline)}  repset ${String(repset)}`;
  });
  return [summaryLine(name, roundIndex, summary), ...pairLines];
}

/**
 * Lists the readings of a calibrated scenario that fall below the timing floors.
 *
 * @param name - The scenario's name.
 * @param rounds - The scenario's rounds: the first, then the confirmation one when it was taken.
 * @returns One line per floor broken, naming the round, the pair's number in it and the value.
 */
function floorBreaks(name: string, rounds: readonly Round[]): string[] {
  return rounds.flatMap((round, roundIndex) =>
    round.readings.flatMap((reading, index) => {
      const where = pairPlace(name, roundIndex, index);
      const span = spanInResolutions(reading);
      const lines: string[] = [];
      if (span < MIN_RESOLUTIONS_PER_SAMPLE) {
        lines.push(
          `${where} median sample spans ${span.toFixed(1)} resolutions, under ${String(MIN_RESOLUTIONS_PER_SAMPLE)}`,
        );
      }
      if (reading.timingMs < reading.minTime) {
        lines.push(
          `${where} timing lasted ${reading.timingMs.toFixed(1)} ms, under minTime ${String(reading.minTime)} ms`,
        );
      }
      return lines;
    }),
  );
}

/**
 * Lays out what the check prints for one judged scenario.
 *
 * @param scenario - The scenario.
 * @param verdict - The scenario's verdict.
 * @param rounds - The scenario's rounds: the first, then the confirmation one when it was taken.
 * @returns The lines to print, and the lines of readings below the timing floors.
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
  const smallestSpan = Math.min(...readings.map(spanInResolutions));
  const shortestTiming = Math.min(...readings.map((reading) => reading.timingMs));
  lines.push(
    `${name}  smallest span ${smallestSpan.toFixed(1)} resolutions  shortest timing ${shortestTiming.toFixed(1)} ms`,
  );
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
 * @returns 1 when any scenario failed or any calibrated reading fell below its timing floors, 0
 *   otherwise.
 * @throws Error naming the scenario when a reading cannot be trusted; the real repset reader's
 *   filesystem errors from creating or removing its temporary directory, which name no scenario;
 *   whatever a caller-supplied reader throws; and whatever `print` throws.
 */
export function runCheck(
  readers: Readers = REAL_READERS,
  print: (text: string) => void = console.log,
): 0 | 1 {
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
  process.exitCode = runCheck();
}
