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

import { quantile } from "../../src/utils.js";
import { BODY_NAMES, type BodyName } from "../check-timing-accuracy/bodies.js";
import { type Reading, type Run, parseArguments, parseRun } from "./parse-input.js";
import { type Interval, levelCuts, levelOf, pairedInterval, twoProportionP } from "./statistics.js";

const EQUIVALENCE_NS = 1;
const MIN_LEVEL_SHARE = 0.05;
const REPSET = "repset";
const BASELINE = "baseline";
const NONE = "none";
const BASELINE_AGAIN = "baseline-again";
const CHILD_BASELINE = "child-baseline";
const CHILD_BASELINE_AGAIN = "child-baseline-again";
const REPSET_CHILD_DIRECT = "repset-child-direct";
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
  REPSET_CHILD_DIRECT,
  CHILD_BASELINE,
  CHILD_BASELINE_AGAIN,
]);

/** A cloud label, and the word its machines' `sysVendor` contains. */
const CLOUD_VENDORS: ReadonlyMap<string, string> = new Map([
  ["azure", "Microsoft"],
  ["aws", "Amazon"],
]);

/** The CPU models coverage requires one counting job on, each with the model names that cover it. */
const REQUIRED_MODELS: readonly { label: string; models: readonly string[] }[] = [
  { label: "EPYC 7763", models: ["EPYC 7763"] },
  { label: "EPYC 9V74 or 9V45", models: ["EPYC 9V74", "EPYC 9V45"] },
];

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
  runs: Run[];
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
    const { runId, runAttempt, pinned, job } = header;
    const named = runId !== null && runAttempt !== null;
    const jobName = job === null ? "" : ` job ${job}`;
    const name = named ? `${runId}/${runAttempt}${jobName}` : file;
    const attempt = getOrAdd(attempts, `${named}\0${name}`, () => ({
      name,
      clouds: new Set<string>(),
      cpus: new Set<string>(),
      groups: new Map<string, Group>(),
      runs: [],
    }));
    attempt.runs.push({ file, cloud, header, readings });
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

/** An A/A control: two baseline children that run the same code must read alike. */
function againControl(
  group: Group,
  again = BASELINE_AGAIN,
  original = BASELINE,
): "pass" | "fail" | "control absent" {
  const sides = sidesOf(group);
  if (!sides.includes(again) || !sides.includes(original)) {
    return "control absent";
  }
  const interval = pairedInterval(pairedDifferences(group, again, original));
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
  if (sides.includes(CHILD_BASELINE_AGAIN) && sides.includes(CHILD_BASELINE)) {
    pairs.push([CHILD_BASELINE_AGAIN, CHILD_BASELINE]);
  }
  return [
    "paired differences (ns):",
    ...pairs.map(([side, other]) => pairLine(group, side, other)),
    ...baselineLines(group, sides),
    `  A/A baseline-again - baseline: ${againControl(group)}`,
    `  A/A child-baseline-again - child-baseline: ${againControl(group, CHILD_BASELINE_AGAIN, CHILD_BASELINE)}`,
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
  const shares = comparisons(sides);
  if (sides.includes(CHILD_BASELINE) && sides.includes(REPSET_CHILD_DIRECT)) {
    shares.push([CHILD_BASELINE, REPSET_CHILD_DIRECT]);
  }
  for (const [side, other] of shares) {
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

/** Whether every side the header names has a reading in every cycle of every body. */
function isFinished({ header, readings }: Run): boolean {
  const read = new Set(readings.map(({ side, body, cycle }) => `${side}\0${body}\0${cycle}`));
  const cycles = Array.from({ length: header.cyclesPerBody }, (_, cycle) => cycle);
  return header.sides.every((side) =>
    BODY_NAMES.every((body) => cycles.every((cycle) => read.has(`${side}\0${body}\0${cycle}`))),
  );
}

/**
 * Whether a job counts toward coverage: its unpinned and its pinned pass both finished, and the
 * child-baseline A/A control passes on unpinned `inlined`.
 */
function coverageOf(attempt: Attempt): { finished: boolean; control: string; counts: boolean } {
  const finished = [false, true].every((pinned) =>
    attempt.runs.some((run) => run.header.pinned === pinned && isFinished(run)),
  );
  const group = attempt.groups.get("false/inlined");
  const control =
    group === undefined
      ? "control absent"
      : againControl(group, CHILD_BASELINE_AGAIN, CHILD_BASELINE);
  return { finished, control, counts: finished && control === "pass" };
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function coverageLine(attempt: Attempt): string {
  const { finished, control, counts } = coverageOf(attempt);
  return `  coverage: both passes finished ${yesNo(finished)}, unpinned inlined child A/A ${control}, counts ${yesNo(counts)}`;
}

function requiredLines(attempts: readonly Attempt[]): string[] {
  return REQUIRED_MODELS.map(({ label, models }) => {
    const covered = attempts.some(
      (attempt) =>
        coverageOf(attempt).counts &&
        [...attempt.cpus].some((cpu) => models.some((model) => cpu.includes(model))),
    );
    return `coverage ${label}: ${covered ? "covered" : "uncovered"}`;
  });
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
 * Builds the report: cloud label warnings, then per attempt (a run attempt's matrix job), pinning
 * and body the paired differences, the comparisons with baseline, the A/A controls, speed levels
 * and per-level details, then per attempt a roll-up line, its coverage conditions and the groups
 * with a baseline offset or with repset levels, then whether each required CPU model is covered.
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
      coverageLine(attempt),
      groupsLine("baseline offset", attempt, hasBaselineOffset),
      groupsLine("repset levels", attempt, hasRepsetLevels),
    ]),
    ...requiredLines(attempts),
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const { levelGap, inputs } = parseArguments(process.argv.slice(2));
  const runs = inputs.map(({ file, cloud }) => parseRun(file, cloud, readFileSync(file, "utf8")));
  process.stdout.write(report(runs, levelGap));
}
