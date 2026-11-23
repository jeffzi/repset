/**
 * The memory timing check: for each body of `check-memory-timing.bench.ts`, on Node, it pairs one
 * run of the built repset command with `--measure time` with one run with `--measure time,memory`,
 * back to back, and judges the pairs with `check-timing-accuracy/verdict.ts`: timing alone is the
 * verdict's baseline side, timing with memory measured its repset side.
 *
 *   node --import tsx scripts/check-memory-timing.ts
 *
 * Run it from the repository root, as the Taskfile does: every path it hands a child is relative to
 * the current directory. It reads `dist/`, so build first. Nothing in it runs two children at once:
 * the check is a measurement, and a second process would move both readings. Only Node reads
 * memory, and every run lets warmup calibrate its count.
 */
import { join } from "node:path";

import { PAIRS, readRepsetRun, type RepsetReading } from "./check-timing-accuracy.js";
import { judgeScenario, type Pairs, type RoundSummary } from "./check-timing-accuracy/verdict.js";

const BODY_NAMES = ["each", "inlined", "allocating", "setup-per-call"] as const;

type BodyName = (typeof BODY_NAMES)[number];

/** The two sides of a pair: each takes one reading of a body. */
export interface Readers {
  /** Reads the body with `--measure time`. */
  readonly alone: (body: BodyName) => RepsetReading;
  /** Reads the body with `--measure time,memory`. */
  readonly withMemory: (body: BodyName) => RepsetReading;
}

type Side = keyof Readers;

type Pair = Readonly<Record<Side, RepsetReading>>;

const BENCH_FILE = join("scripts", "check-memory-timing.bench.ts");

const MEASURE: Readonly<Record<Side, string>> = { alone: "time", withMemory: "time,memory" };

// ---------------------------------------------------------------------------
// Reading repset
// ---------------------------------------------------------------------------

/**
 * Runs the repset command once on `body` on Node, measuring what `side` measures.
 *
 * @param body - The body to read.
 * @param side - Whether the run measures time alone or time and memory.
 * @returns The reading of the body's one result.
 * @throws Error naming the body and the side when the command cannot start, its run cannot be
 *   trusted, or a run with memory measured holds no memory reading.
 * @throws The filesystem error from creating or removing the run's temporary directory.
 */
function readRun(body: BodyName, side: Side): RepsetReading {
  const name = `${body} (--measure ${MEASURE[side]})`;
  return readRepsetRun(
    name,
    [
      BENCH_FILE,
      "--runtime",
      "node",
      "--filter",
      `^check-memory-timing/${body}$`,
      "--measure",
      MEASURE[side],
    ],
    (result) => {
      if (side === "withMemory" && result.memory === null) {
        throw new Error(`${name}: repset's report holds no memory reading`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * Reads one pair of `body`, the side `aloneFirst` names first.
 *
 * @param body - The body to read.
 * @param readers - The two sides' readers.
 * @param aloneFirst - Whether timing alone runs before timing with memory.
 * @returns Both sides' readings.
 * @throws Whatever a reader throws.
 */
function readPair(body: BodyName, readers: Readers, aloneFirst: boolean): Pair {
  if (aloneFirst) {
    const alone = readers.alone(body);
    return { alone, withMemory: readers.withMemory(body) };
  }
  const withMemory = readers.withMemory(body);
  return { alone: readers.alone(body), withMemory };
}

/**
 * Takes one round of a body: {@link PAIRS} pairs, back to back, the first timing alone first and
 * the order flipping each pair.
 *
 * A pair's per-call resolution is the coarser timer resolution of its two readings divided by
 * their fewer calls per sample, so a tie on either side stays a tie.
 *
 * @param body - The body to read.
 * @param readers - The two sides' readers.
 * @returns The round's pairs: timing alone as the baseline side, timing with memory as the repset
 *   side.
 * @throws Whatever a reader throws.
 */
function takeRound(body: BodyName, readers: Readers): Pairs {
  const baseline: number[] = [];
  const repset: number[] = [];
  const perCallResolutions: number[] = [];
  for (let pair = 0; pair < PAIRS; pair += 1) {
    const { alone, withMemory } = readPair(body, readers, pair % 2 === 0);
    baseline.push(alone.median);
    repset.push(withMemory.median);
    perCallResolutions.push(
      Math.max(alone.timerResolutionNs, withMemory.timerResolutionNs) /
        Math.min(alone.callsPerSample, withMemory.callsPerSample),
    );
  }
  return { baseline, repset, perCallResolutions };
}

/**
 * Lays out one round's summary: both medians, the gap and the p-value.
 *
 * @param body - The body the round read.
 * @param roundIndex - 0 for the first round, 1 for the confirmation.
 * @param summary - The verdict's summary of the round.
 * @returns The summary line.
 */
function summaryLine(body: BodyName, roundIndex: number, summary: RoundSummary): string {
  const label = roundIndex === 0 ? "first" : "confirmation";
  return `${body}  ${label} round  time ${summary.baselineMedian.toFixed(1)} ns  time,memory ${summary.repsetMedian.toFixed(1)} ns  gap ${(summary.gap * 100).toFixed(2)}%  p=${summary.pValue.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Running the check
// ---------------------------------------------------------------------------

/**
 * Runs the memory timing check over every body, one reading at a time, printing each once judged.
 *
 * @param readers - The two sides' readers; the real ones run `dist/cli.js`.
 * @param print - Where each body's lines go.
 * @returns 1 when any body's timing with memory measured differs from its timing alone in both
 *   rounds, in the same direction, 0 otherwise.
 * @throws Error naming the body and the side when a reading cannot be trusted; the real reader's
 *   filesystem errors from creating or removing its temporary directory, which name no body;
 *   whatever a caller-supplied reader throws; and whatever `print` throws.
 */
export function runCheck(readers: Readers, print: (text: string) => void = console.log): 0 | 1 {
  let failed = false;
  for (const body of BODY_NAMES) {
    const verdict = judgeScenario(takeRound(body, readers), () => takeRound(body, readers));
    const summaries =
      verdict.confirmation === undefined ? [verdict.first] : [verdict.first, verdict.confirmation];
    const lines = summaries.map((summary, roundIndex) => summaryLine(body, roundIndex, summary));
    lines.push(`${body}  ${verdict.passed ? "pass" : "FAIL"}`);
    failed ||= !verdict.passed;
    print(lines.join("\n"));
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = runCheck({
    alone: (body) => readRun(body, "alone"),
    withMemory: (body) => readRun(body, "withMemory"),
  });
}
