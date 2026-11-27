/**
 * The layout the timing checks share for a judged round: its summary line, then one line per pair.
 */
import { valueAt } from "../../src/utils.js";
import type { Pairs, RoundSummary, ScenarioVerdict } from "./verdict.js";

/**
 * Formats a number with two decimals and an explicit sign.
 *
 * @param value - The number to format.
 * @returns `value` with two decimals, prefixed `+` when it is zero or positive.
 */
function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** Formats a fraction as a signed percent with two decimals. */
function formatSignedPercent(fraction: number): string {
  return `${formatSigned(fraction * 100)}%`;
}

function roundLabel(roundIndex: number): string {
  return roundIndex === 0 ? "first" : "confirmation";
}

/**
 * Prefixes one line of a timing check's output with the name of what it judged.
 *
 * @param name - The scenario's or body's name.
 * @param text - The rest of the line.
 * @returns `<name>  <text>`.
 */
export function scenarioLine(name: string, text: string): string {
  return `${name}  ${text}`;
}

/**
 * Names one pair of a round.
 *
 * @param name - The scenario's or body's name.
 * @param roundIndex - 0 for the first round, 1 for the confirmation.
 * @param pairIndex - The pair's index in its round, from 0.
 * @returns `<name>  <first|confirmation> round, pair <n>:`.
 */
export function pairPlace(name: string, roundIndex: number, pairIndex: number): string {
  return scenarioLine(name, `${roundLabel(roundIndex)} round, pair ${String(pairIndex + 1)}:`);
}

/** What a round's summary and pair lines call each side of its pairs. */
export interface SideLabels {
  readonly baseline: string;
  readonly repset: string;
}

/**
 * Lays out one round's summary: both medians, the gap, the mean paired difference, whose sign is
 * the direction the verdict tests, that mean relative to the baseline median in percent, and the
 * p-value.
 *
 * @param name - The scenario's or body's name.
 * @param roundIndex - 0 for the first round, 1 for the confirmation.
 * @param summary - The verdict's summary of the round.
 * @param sides - What the line calls the baseline side and the repset side.
 * @returns The summary line.
 */
function summaryLine(
  name: string,
  roundIndex: number,
  summary: RoundSummary,
  sides: SideLabels,
): string {
  const relativeMean = summary.meanDifference / summary.baselineMedian;
  return scenarioLine(
    name,
    `${roundLabel(roundIndex)} round  ${sides.baseline} ${summary.baselineMedian.toFixed(1)} ns  ${sides.repset} ${summary.repsetMedian.toFixed(1)} ns  gap ${formatSignedPercent(summary.gap)}  mean diff ${formatSigned(summary.meanDifference)} ns (${formatSignedPercent(relativeMean)})  p=${summary.pValue.toFixed(4)}`,
  );
}

/**
 * Lays out every round taken: for each, its summary line, then one line per pair with both medians
 * at full precision.
 *
 * @param name - The scenario's or body's name.
 * @param verdict - The verdict judging the rounds.
 * @param rounds - Each round's pairs: the first round's, then the confirmation round's when it was
 *   taken.
 * @param sides - What the summary lines and the pair lines call the baseline side and the repset
 *   side.
 * @returns Each round's summary line followed by its pair lines in pair order, round after round.
 * @throws Error naming `name` when a confirmation round was taken but `verdict` holds no
 *   confirmation summary.
 * @throws RangeError when a round's `repset` medians are fewer than its `baseline` ones.
 */
export function roundLines(
  name: string,
  verdict: ScenarioVerdict,
  rounds: readonly Pairs[],
  sides: SideLabels,
): string[] {
  return rounds.flatMap((pairs, roundIndex) => {
    const summary = roundIndex === 0 ? verdict.first : verdict.confirmation;
    if (summary === undefined) {
      throw new Error(`${name}: the confirmation round has no confirmation summary`);
    }
    const pairLines = pairs.baseline.map((baseline, pairIndex) => {
      const repset = valueAt(pairs.repset, pairIndex);
      return `${pairPlace(name, roundIndex, pairIndex)}  ${sides.baseline} ${String(baseline)}  ${sides.repset} ${String(repset)}`;
    });
    return [summaryLine(name, roundIndex, summary, sides), ...pairLines];
  });
}
