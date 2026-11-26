/**
 * Reads the JSON Lines files of Bun timing-gap diagnosis runs and prints a plain-text report on
 * stdout:
 *
 * ```sh
 * node --import tsx scripts/diagnose-bun-gap/analyze.ts [--level-gap <ns>] <file>=<cloud> [...]
 * ```
 *
 * Each file holds a header line, then one reading per line. `<cloud>` labels the machine the file
 * came from, such as `azure` or `aws`.
 */
import { readFileSync } from "node:fs";

import { quantile, valueAt } from "../../src/utils.js";
import { BODY_NAMES } from "../check-timing-accuracy/bodies.js";
import type { BodyName } from "../check-timing-accuracy/bodies.js";
import { parseArguments, parseRun } from "./parse-input.js";
import type { Reading, Run } from "./parse-input.js";

/** The mean of paired differences and its 95 % interval. */
export interface Interval {
  n: number;
  mean: number;
  low: number;
  high: number;
}

const Z_95 = 1.96;
const EQUIVALENCE_NS = 1;
const MIN_LEVEL_SHARE = 0.05;
const REPSET = "repset";
const BASELINE = "baseline";
const NONE = "none";
const BASELINE_AGAIN = "baseline-again";
const ALPHA = 0.05;

/**
 * The sides the start-CPU breakdown leaves out: repset, and the baseline children that report no
 * CPU.
 */
const SIDES_WITHOUT_CPU: ReadonlySet<string> = new Set([
  REPSET,
  BASELINE,
  BASELINE_AGAIN,
  "baseline-args",
  "baseline-async",
  "baseline-table",
  "baseline-with-variants",
  "baseline-child-modules",
  "baseline-under-parent",
  "repset-child-direct",
]);

/** A cloud label, and the word its machines' `sysVendor` contains. */
const CLOUD_VENDORS: ReadonlyMap<string, string> = new Map([
  ["azure", "Microsoft"],
  ["aws", "Amazon"],
]);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Computes the mean of paired differences and its 95 % interval, mean ± 1.96 × sd/√n with sd the
 * sample standard deviation.
 *
 * @param differences - One difference per pair.
 * @returns The pair count, the mean and the interval's bounds; the bounds are NaN under two pairs.
 */
export function pairedInterval(differences: readonly number[]): Interval {
  const n = differences.length;
  const mean = differences.reduce((total, value) => total + value, 0) / n;
  const variance = differences.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1);
  const half = Z_95 * Math.sqrt(variance / n);
  return { n, mean, low: mean - half, high: mean + half };
}

/**
 * Splits values into speed levels: sorted, a new level starts wherever two neighbors differ by
 * more than the gap.
 *
 * @param values - The values to split, in any order.
 * @param gap - The largest difference between neighbors on one level.
 * @returns The ascending cuts, each midway between the two neighbors it separates; a value above
 *   `k` cuts sits on level `k`.
 */
export function levelCuts(values: readonly number[], gap: number): number[] {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.slice(1).flatMap((high, index) => {
    const low = valueAt(sorted, index);
    return high - low > gap ? [(low + high) / 2] : [];
  });
}

function levelOf(value: number, cuts: readonly number[]): number {
  return cuts.filter((cut) => value > cut).length;
}

/** The complementary error function for x ≥ 0, to 1.5e-7: Handbook of Mathematical Functions, formula 7.1.26. */
function complementaryError(x: number): number {
  const t = 1 / (1 + 0.327_591_1 * x);
  const poly =
    t *
    (0.254_829_592 +
      t * (-0.284_496_736 + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
  return poly * Math.exp(-x * x);
}

/**
 * Tests whether two shares differ, with the two-sided two-proportion z-test on the pooled
 * proportion.
 *
 * @param offA - The count of hits in the first sample.
 * @param totalA - The size of the first sample.
 * @param offB - The count of hits in the second sample.
 * @param totalB - The size of the second sample.
 * @returns The p-value; 1 when the pooled proportion is 0 or 1, as no difference is possible.
 */
export function twoProportionP(offA: number, totalA: number, offB: number, totalB: number): number {
  const pooled = (offA + offB) / (totalA + totalB);
  if (pooled === 0 || pooled === 1) {
    return 1;
  }
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  const z = (offA / totalA - offB / totalB) / standardError;
  return complementaryError(Math.abs(z) / Math.SQRT2);
}

// ---------------------------------------------------------------------------
// Grouping and the report
// ---------------------------------------------------------------------------

/** A reading with its speed level, keyed by its file and cycle so pairs never span two files. */
interface Entry {
  key: string;
  level: number;
  reading: Reading;
}

interface Group {
  pinned: boolean;
  body: BodyName;
  cuts: number[];
  entries: Entry[];
}

interface Attempt {
  name: string;
  clouds: Set<string>;
  cpus: Set<string>;
  groups: Map<string, Group>;
}

function getOrAdd<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) {
    return found;
  }
  const made = make();
  map.set(key, made);
  return made;
}

function groupRuns(runs: readonly Run[], levelGap: number): Attempt[] {
  const attempts = new Map<string, Attempt>();
  for (const { file, cloud, header, readings } of runs) {
    const { runId, runAttempt, pinned } = header;
    const named = runId !== null && runAttempt !== null;
    const name = named ? `${runId}/${runAttempt}` : file;
    const attempt = getOrAdd(attempts, `${named}\0${name}`, () => ({
      name,
      clouds: new Set<string>(),
      cpus: new Set<string>(),
      groups: new Map<string, Group>(),
    }));
    attempt.clouds.add(cloud);
    attempt.cpus.add(header.cpuModel ?? "unknown");
    for (const reading of readings) {
      const { body, cycle } = reading;
      const group = getOrAdd(attempt.groups, `${pinned}/${body}`, () => ({
        pinned,
        body,
        cuts: [],
        entries: [],
      }));
      group.entries.push({ key: `${file}\0${cycle}`, level: 0, reading });
    }
  }
  const all = [...attempts.values()];
  for (const group of all.flatMap((attempt) => [...attempt.groups.values()])) {
    group.cuts = levelCuts(
      group.entries.map(({ reading }) => reading.median),
      levelGap,
    );
    for (const entry of group.entries) {
      entry.level = levelOf(entry.reading.median, group.cuts);
    }
  }
  return all;
}

function cloudWarning({ file, cloud, header }: Run): string[] {
  const vendor = header.sysVendor;
  if (vendor === null) {
    return [];
  }
  const label = cloud.toLowerCase();
  const agrees = [...CLOUD_VENDORS].every(
    ([name, word]) => (name === label) === vendor.includes(word),
  );
  return agrees ? [] : [`warning: ${file} is tagged ${cloud}, but its sysVendor is ${vendor}`];
}

function pinningOf(pinned: boolean): "pinned" | "unpinned" {
  return pinned ? "pinned" : "unpinned";
}

function describe(attempt: Attempt): string {
  return `${attempt.name}: ${[...attempt.clouds].join("+")}, ${[...attempt.cpus].join("+")}`;
}

function sidesOf(group: Group): string[] {
  return [...new Set(group.entries.map(({ reading }) => reading.side))];
}

function entriesOf(group: Group, side: string): Entry[] {
  return group.entries.filter(({ reading }) => reading.side === side);
}

/** Each side paired with none, then each side other than none paired with repset. */
function comparisons(sides: readonly string[]): (readonly [string, string])[] {
  const others = (other: string): (readonly [string, string])[] =>
    sides.includes(other)
      ? sides
          .filter((side) => side !== other && side !== NONE)
          .map((side) => [side, other] as const)
      : [];
  return [...others(NONE), ...others(REPSET)];
}

function pairedDifferences(group: Group, side: string, other: string, onLevel0 = false): number[] {
  const others = new Map(entriesOf(group, other).map((entry) => [entry.key, entry]));
  return entriesOf(group, side).flatMap(({ key, level, reading }) => {
    const match = others.get(key);
    const kept = match !== undefined && (!onLevel0 || (level === 0 && match.level === 0));
    return kept ? [reading.median - match.reading.median] : [];
  });
}

/** The pair count, then the mean and its interval from two pairs on: one pair has no spread. */
function intervalText({ n, mean, low, high }: Interval): string {
  return n < 2
    ? `n=${n}`
    : `n=${n} mean=${mean.toFixed(2)} 95% [${low.toFixed(2)}, ${high.toFixed(2)}]`;
}

/** Whether the interval holds zero; false when a bound is NaN. */
function holdsZero({ low, high }: Interval): boolean {
  return low <= 0 && high >= 0;
}

function pairLine(group: Group, side: string, other: string): string {
  const interval = pairedInterval(pairedDifferences(group, side, other));
  const { low, high } = interval;
  const containsZero = holdsZero(interval);
  let verdict = "";
  if (side === REPSET) {
    const within = low >= -EQUIVALENCE_NS && high <= EQUIVALENCE_NS && containsZero;
    verdict = ` equivalent: ${within ? "yes" : "no"}`;
  } else if (side === NONE && other === BASELINE) {
    verdict = containsZero ? " control pass" : " control FAIL";
  }
  return `  ${side} - ${other}: ${intervalText(interval)}${verdict}`;
}

function baselineLine(group: Group, side: string, onLevel0: boolean): string {
  const cycles = onLevel0 ? "level 0" : "all cycles";
  const interval = pairedInterval(pairedDifferences(group, side, BASELINE, onLevel0));
  return `  ${side} - baseline ${cycles}: ${intervalText(interval)}`;
}

function baselineLines(group: Group, sides: readonly string[]): string[] {
  if (!sides.includes(BASELINE)) {
    return [];
  }
  return sides.flatMap((side) =>
    side === BASELINE ? [] : [baselineLine(group, side, false), baselineLine(group, side, true)],
  );
}

/** The A/A control: two baseline children that run the same code must read alike. */
function againControl(group: Group): "pass" | "fail" | "control absent" {
  const sides = sidesOf(group);
  if (!sides.includes(BASELINE_AGAIN) || !sides.includes(BASELINE)) {
    return "control absent";
  }
  const interval = pairedInterval(pairedDifferences(group, BASELINE_AGAIN, BASELINE));
  // Under two pairs there is no interval to test: no control, rather than a failed one.
  if (interval.n < 2) return "control absent";
  return holdsZero(interval) ? "pass" : "fail";
}

function pairLines(group: Group): string[] {
  const sides = sidesOf(group);
  const pairs = comparisons(sides).map(([side, other]) =>
    other === REPSET ? ([REPSET, side] as const) : ([side, other] as const),
  );
  if (sides.includes(NONE) && sides.includes(BASELINE)) {
    pairs.push([NONE, BASELINE]);
  }
  return [
    "paired differences (ns):",
    ...pairs.map(([side, other]) => pairLine(group, side, other)),
    ...baselineLines(group, sides),
    `  A/A baseline-again - baseline: ${againControl(group)}`,
  ];
}

function levelCounts(entries: readonly Entry[], cuts: readonly number[]): number[] {
  const counts = [0, ...cuts.map(() => 0)];
  for (const { level } of entries) {
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

function offLevel0(group: Group, side: string): { off: number; total: number } {
  const entries = entriesOf(group, side);
  return { off: entries.filter(({ level }) => level > 0).length, total: entries.length };
}

function percent({ off, total }: { off: number; total: number }): string {
  return `${((off / total) * 100).toFixed(1)}%`;
}

function levelLines(group: Group, levelGap: number): string[] {
  const cuts =
    group.cuts.length === 0 ? "none" : group.cuts.map((cut) => cut.toFixed(1)).join(", ");
  const lines = [`speed levels (gap ${levelGap} ns, cuts ${cuts}):`];
  const sides = sidesOf(group);
  for (const side of sides) {
    const counts = levelCounts(entriesOf(group, side), group.cuts);
    lines.push(`  ${side}: ${counts.map((count, level) => `level ${level} ${count}`).join(", ")}`);
  }
  for (const [side, other] of comparisons(sides)) {
    const a = offLevel0(group, side);
    const b = offLevel0(group, other);
    const p = twoProportionP(a.off, a.total, b.off, b.total);
    lines.push(
      `  ${side} vs ${other}: off level 0 ${percent(a)} vs ${percent(b)}, p=${p.toFixed(4)}`,
    );
  }
  return lines;
}

function variantLine(readings: readonly Reading[], cuts: readonly number[]): string {
  const byCpu = new Map<string, number>();
  for (const { cpuStart } of readings) {
    const cpu = String(cpuStart);
    byCpu.set(cpu, (byCpu.get(cpu) ?? 0) + 1);
  }
  const moved = readings.filter(
    ({ cpuStart, cpuEnd }) => cpuStart !== null && cpuEnd !== null && cpuStart !== cpuEnd,
  ).length;
  const steady = readings.filter(
    ({ firstHalfMedian: first, secondHalfMedian: second }) =>
      first !== null && second !== null && levelOf(first, cuts) === levelOf(second, cuts),
  ).length;
  const cpus = [...byCpu].map(([cpu, count]) => `${cpu} ${count}`).join(", ");
  return `  variants by cpuStart: ${cpus}; cpuStart != cpuEnd ${moved}; halves on one level ${steady}`;
}

function sampleCountLine(readings: readonly Reading[]): string {
  const sorted = readings.map(({ sampleCount }) => sampleCount).toSorted((a, b) => a - b);
  const [min, median, max] = [0, 0.5, 1].map((q) => quantile(sorted, q));
  return `  repset sampleCount: min ${min} median ${median} max ${max}`;
}

function levelDetailLines(group: Group): string[] {
  const lines: string[] = [];
  for (let level = 0; level <= group.cuts.length; level += 1) {
    const readings = group.entries
      .filter((entry) => entry.level === level)
      .map(({ reading }) => reading);
    const variants = readings.filter(({ side }) => !SIDES_WITHOUT_CPU.has(side));
    const repsetReadings = readings.filter(({ side }) => side === REPSET);
    lines.push(`level ${level}:`);
    if (variants.length > 0) {
      lines.push(variantLine(variants, group.cuts));
    }
    if (repsetReadings.length > 0) {
      lines.push(sampleCountLine(repsetReadings));
    }
  }
  return lines;
}

function hasLevels(group: Group): boolean {
  const counts = levelCounts(group.entries, group.cuts);
  return counts.filter((count) => count / group.entries.length >= MIN_LEVEL_SHARE).length >= 2;
}

function hasSteadyOffset(group: Group): boolean {
  return pairedInterval(pairedDifferences(group, REPSET, BASELINE, true)).low > 0;
}

function rollUpLine(attempt: Attempt): string {
  const groups = [...attempt.groups.values()];
  const pinnings = new Set(groups.map(({ pinned }) => pinningOf(pinned)));
  const pairs = BODY_NAMES.map((body) => {
    const inBody = groups.filter((group) => group.body === body);
    const count = inBody.reduce(
      (total, group) => total + pairedDifferences(group, REPSET, BASELINE).length,
      0,
    );
    return `${body} ${count}`;
  });
  const forms = [
    ...(groups.some(hasLevels) ? ["levels"] : []),
    ...(groups.some(hasSteadyOffset) ? ["steady offset"] : []),
  ];
  const shown = forms.length === 0 ? "none" : forms.join(", ");
  return `attempt ${describe(attempt)}, ${[...pinnings].join("+")}, pairs ${pairs.join(" ")}, forms ${shown}`;
}

function hasBaselineOffset(group: Group): boolean {
  const { low, high } = pairedInterval(pairedDifferences(group, NONE, BASELINE, true));
  return (low > 0 || high < 0) && againControl(group) === "pass";
}

/**
 * Whether repset leaves level 0 more often than baseline: the two-sided two-proportion p the level
 * lines print is under 0.05, and repset's share is the larger.
 */
function hasRepsetLevels(group: Group): boolean {
  const a = offLevel0(group, REPSET);
  const b = offLevel0(group, BASELINE);
  return (
    a.off / a.total > b.off / b.total &&
    twoProportionP(a.off, a.total, b.off, b.total) < ALPHA &&
    againControl(group) === "pass"
  );
}

function groupsLine(label: string, attempt: Attempt, qualifies: (group: Group) => boolean): string {
  const names = [...attempt.groups.values()]
    .filter((group) => qualifies(group))
    .map(({ pinned, body }) => `${pinningOf(pinned)} ${body}`);
  return `  ${label}: ${names.length === 0 ? "none" : names.join(", ")}`;
}

/**
 * Builds the report: cloud label warnings, then per attempt, pinning and body the paired
 * differences, the comparisons with baseline and its A/A control, speed levels and per-level
 * details, then per attempt a roll-up line and the groups with a baseline offset or with repset
 * levels.
 *
 * @param runs - The parsed run files.
 * @param levelGap - The largest difference in ns between neighboring medians on one level.
 * @returns The report's text, ending with a newline.
 */
export function report(runs: readonly Run[], levelGap: number): string {
  const attempts = groupRuns(runs, levelGap);
  const lines = runs.flatMap((run) => cloudWarning(run));
  for (const attempt of attempts) {
    lines.push("", `== attempt ${describe(attempt)} ==`);
    for (const group of attempt.groups.values()) {
      lines.push(
        `-- ${pinningOf(group.pinned)}, ${group.body} --`,
        ...pairLines(group),
        ...levelLines(group, levelGap),
        ...levelDetailLines(group),
      );
    }
  }
  lines.push(
    "",
    "== roll-up ==",
    ...attempts.flatMap((attempt) => [
      rollUpLine(attempt),
      groupsLine("baseline offset", attempt, hasBaselineOffset),
      groupsLine("repset levels", attempt, hasRepsetLevels),
    ]),
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const { levelGap, inputs } = parseArguments(process.argv.slice(2));
  const runs = inputs.map(({ file, cloud }) => parseRun(file, cloud, readFileSync(file, "utf8")));
  process.stdout.write(report(runs, levelGap));
}
