/**
 * The text a run shows a person: the table of its results.
 *
 * Pure functions from the report's types to text; nothing here prints.
 */
import { stripVTControlCharacters, styleText } from "node:util";

import type { ChildError } from "./child.js";
import type { Contest, FailedResult, MeasuredResult, Result } from "./report.js";

/** Time units from nanoseconds up, each a thousand of the one before. */
const TIME_UNITS = ["ns", "µs", "ms", "s"] as const;

/** How many of one time unit make one of the next. */
const UNIT_STEP = 1000;

const SIGNIFICANT_DIGITS = 3;

const COLUMN_SEPARATOR = " │ ";

const HEADER = ["case", "median", "mean", "min", "max", "samples"] as const;

const ALIGN = ["left", "right", "right", "right", "right", "right"] as const;

const CONTEST_HEADER = ["contender", "median", "ratio", "rank"] as const;

const CONTEST_ALIGN = ["left", "right", "left", "right"] as const;

const FOOTER =
  "Each case was measured once, in its own process. A verdict between revisions takes a comparison tool.";

const PLAIN_FOOTER =
  "Each plain case was measured once, in its own process. A verdict between revisions takes a comparison tool.";

const JUDGED_FOOTER =
  "A shared rank means the rounds did not tell those contenders apart, and a lower rank alone is not a verdict. A verdict made at a later Holm step can show an interval that touches 1.";

const NONE_JUDGED_FOOTER =
  "No contest was judged: a verdict needs more rounds than these contests ran. Without a verdict, these medians do not order the contenders.";

type Style = "bold" | "dim" | "red" | "green";

type Align = "left" | "right";

/** A run of consecutive plain cases, or one contest's results, within a runtime's section. */
interface Block {
  readonly contest: Contest | null;
  readonly results: Result[];
}

/**
 * Styles `text` when `color` holds. The caller has judged the stream, so the escape codes come
 * whatever stream `styleText` would judge by default.
 *
 * @param style - The style to apply.
 * @param text - The text to style.
 * @param color - Whether the stream the text goes to shows color.
 * @returns `text` wrapped in the style's escape codes when `color` holds, `text` otherwise.
 */
export function paint(style: Style, text: string, color: boolean): string {
  return color ? styleText(style, text, { validateStream: false }) : text;
}

/** The columns `text` takes on a terminal, escape codes excluded. */
function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

/** Prints `value` with three significant digits, never in exponent form. */
function significant(value: number): string {
  const text = value.toPrecision(SIGNIFICANT_DIGITS);
  return text.includes("e") ? String(Number(text)) : text;
}

/** Prints a time in nanoseconds in the unit that keeps three significant digits, up to seconds. */
function formatTime(ns: number): string {
  let value = ns;
  let unit = 0;
  // Compare the rounded value, so 999.7 ns prints as 1.00 µs rather than 1000 ns.
  while (unit < TIME_UNITS.length - 1 && Math.abs(Number(significant(value))) >= UNIT_STEP) {
    value /= UNIT_STEP;
    unit += 1;
  }
  return `${significant(value)} ${TIME_UNITS[unit]}`;
}

/**
 * Formats a measured case's row; the median comes from the result, the other statistics from its
 * one process.
 *
 * @param result - The measured result.
 * @returns Its id, median, mean, min, max and sample count, the times per call.
 */
function measuredCells(result: MeasuredResult): string[] {
  const { stats } = result.processes[0];
  return [
    result.id,
    formatTime(result.median),
    formatTime(stats.mean),
    formatTime(stats.min),
    formatTime(stats.max),
    String(stats.sampleCount),
  ];
}

/**
 * The width of each of `header`'s columns: the widest cell of the header and `rows` in it.
 *
 * @param header - The column header, which sets the column count.
 * @param rows - The rows; a failed row holds only its first cell.
 * @returns The width of each column.
 */
function columnWidths(header: readonly string[], rows: readonly (readonly string[])[]): number[] {
  return header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => visibleWidth(row[column] ?? ""))),
  );
}

/** Lays out `row` in columns of `widths`, each padded on the side `align` names. */
function alignRow(
  row: readonly string[],
  widths: readonly number[],
  align: readonly Align[],
): string {
  return row
    .map((cell, column) => {
      const width = widths[column] ?? 0;
      return align[column] === "left" ? cell.padEnd(width) : cell.padStart(width);
    })
    .join(COLUMN_SEPARATOR);
}

/**
 * A horizontal rule under columns of `widths`, `junction` where each column separator crosses it.
 *
 * @param junction - The character drawn under each separator's bar.
 * @param widths - The width of each column.
 * @returns The rule, as wide as a row whose every cell fills its column.
 */
function rule(junction: string, widths: readonly number[]): string {
  const last = widths.length - 1;
  // A separator pads its bar with a space each side, so an inner column's run spans both pads.
  return widths
    .map((width, column) => "─".repeat(width + (column === 0 || column === last ? 1 : 2)))
    .join(junction);
}

/**
 * A message's lines after a lead, each further line opened by `continuation`.
 *
 * @param lead - What opens the first line, before the message.
 * @param message - The message, which may span lines.
 * @param continuation - What opens each further line; by default blanks as wide as `lead`, so a
 *   multi-line message reads as one block.
 * @returns The lead and the message's first line, then each further line of the message after
 *   `continuation`.
 */
function leadLines(
  lead: string,
  message: string,
  continuation = " ".repeat(visibleWidth(lead)),
): string[] {
  const [first = "", ...rest] = message.split("\n");
  return [`${lead}${first}`, ...rest.map((line) => `${continuation}${line}`)];
}

/**
 * The lines of a failure, with the labelled lines of its cleanup teardown's failure beneath them.
 *
 * @param lead - What opens the first line, before the failure's message.
 * @param error - The failure's message, and its cleanup teardown's failure or `null` when none
 *   threw.
 * @param teardownIndent - What opens the teardown's first line: the column its lines start at.
 * @param continuation - What opens each further line of the message; by default blanks as wide as
 *   `lead`, so they start beneath the message's first character.
 * @returns The lead and the message's first line, then each further line of the message after
 *   `continuation`, then the teardown's label and message, its further lines beneath its first,
 *   when it threw.
 */
export function failureLines(
  lead: string,
  error: Pick<ChildError, "message" | "teardownError">,
  teardownIndent: string,
  continuation?: string,
): string[] {
  const { message, teardownError } = error;
  const teardown =
    teardownError === null
      ? []
      : leadLines(`${teardownIndent}teardown also failed: `, teardownError.message);
  return [...leadLines(lead, message, continuation), ...teardown];
}

/**
 * Formats a failed case as a row whose failure spans the columns after its label.
 *
 * @param label - What its first cell shows: its case id, or its key in a contest.
 * @param result - The failed result.
 * @param idWidth - The width the label is padded to.
 * @param color - Whether to show its failure in red.
 * @returns Its row, then each further line of its message, then the labelled lines of its cleanup
 *   teardown's failure when that teardown threw too, each starting where the failure starts.
 */
function failedLines(
  label: string,
  result: FailedResult,
  idWidth: number,
  color: boolean,
): string[] {
  const idCell = `${label.padEnd(idWidth)}${COLUMN_SEPARATOR}`;
  const failure = paint("red", `failed in ${result.error.phase}`, color);
  const cellStart = " ".repeat(visibleWidth(idCell));
  return failureLines(`${idCell}${failure}: `, result.error, cellStart, cellStart);
}

/** The columns of a boxed table and how a result fills them. */
interface Columns {
  /** Sets the column count. */
  readonly header: readonly string[];
  readonly align: readonly Align[];
  readonly cellsOf: (result: MeasuredResult) => string[];
  /** What a failed result's first cell shows. */
  readonly labelOf: (result: Result) => string;
}

/**
 * Lays out a boxed table: the column header between two rules, then a row per result.
 *
 * @param columns - The columns and how a result fills them.
 * @param results - The results to row, in order.
 * @param color - Whether to show the rules and column header dim and each failure in red.
 * @returns A rule, the column header, a rule, then each result's row.
 */
function boxLines(
  { header, align, cellsOf, labelOf }: Columns,
  results: readonly Result[],
  color: boolean,
): string[] {
  const cells = results.map((result) =>
    result.status === "ok" ? cellsOf(result) : [labelOf(result)],
  );
  const widths = columnWidths(header, cells);
  const rows = results.flatMap((result, index) =>
    result.status === "ok"
      ? [alignRow(cells[index] ?? [], widths, align)]
      : failedLines(labelOf(result), result, widths[0] ?? 0, color),
  );
  return [
    paint("dim", rule("┬", widths), color),
    paint("dim", alignRow(header, widths, align), color),
    paint("dim", rule("┼", widths), color),
    ...rows,
  ];
}

const PLAIN_COLUMNS: Columns = {
  header: HEADER,
  align: ALIGN,
  cellsOf: measuredCells,
  labelOf: ({ id }) => id,
};

/** Prints a ratio with two decimals, as `1.16` or `0.98`. */
function ratioText(ratio: number): string {
  return ratio.toFixed(2);
}

/** `count` of `noun`, in the singular for one. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** What a contender's row shows first: its key in the contest, or its case id when it has none. */
function contenderLabel(result: Result): string {
  return result.contender ?? result.id;
}

/**
 * The cells of a measured contender's row.
 *
 * @param contest - Its contest's entry.
 * @param result - Its result.
 * @returns Its key and median, then, when the contest was judged, its ratio to the first contender
 *   with the interval of their pair, and its rank.
 */
function contenderCells(contest: Contest, result: MeasuredResult): string[] {
  const label = contenderLabel(result);
  if (contest.pairs.length === 0) return [label, formatTime(result.median)];
  const entry = contest.contenders.find(({ id }) => id === result.id);
  const ratio = entry?.ratio == null ? "" : `${ratioText(entry.ratio)}×`;
  const firstId = contest.contenders[0]?.id;
  const pair = contest.pairs.find(({ a, b }) => a === firstId && b === result.id);
  const interval =
    pair === undefined ? "" : ` (${ratioText(pair.interval[0])}–${ratioText(pair.interval[1])})`;
  const rank = entry?.rank == null ? "" : String(entry.rank);
  return [label, formatTime(result.median), `${ratio}${interval}`, rank];
}

/**
 * Lays out one contest's sub-table.
 *
 * @param contest - The contest's entry.
 * @param contestResults - Its contenders' results.
 * @param color - Whether to show the name bold, the rounds, rules, header and `not judged` line dim
 *   and each failure in red.
 * @returns The contest's name and rounds, a rule, the column header, a rule, a row per contender
 *   in the entry's order, then the `not judged` line when the contest was not judged.
 */
function contestLines(
  contest: Contest,
  contestResults: readonly Result[],
  color: boolean,
): string[] {
  const order = contest.contenders.map(({ id }) => id);
  const results = contestResults.toSorted(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
  const judged = contest.pairs.length > 0;
  const header = judged ? CONTEST_HEADER : CONTEST_HEADER.slice(0, 2);
  const rounds = plural(contest.rounds, "round");
  return [
    `${paint("bold", contest.name, color)}${paint("dim", ` · ${rounds}`, color)}`,
    ...boxLines(
      {
        header,
        align: CONTEST_ALIGN,
        cellsOf: (result) => contenderCells(contest, result),
        labelOf: contenderLabel,
      },
      results,
      color,
    ),
    ...(judged ? [] : [paint("dim", `not judged: ${rounds}`, color)]),
  ];
}

/**
 * Splits a runtime's results into blocks in run order: each contest's results in one block,
 * opened where the first of them ran, and the plain cases between them in blocks of their own.
 *
 * @param results - The runtime's results, in run order.
 * @param contestOf - The contest entry of each contender's case id on this runtime.
 * @returns The blocks, in run order.
 */
function blocksOf(results: readonly Result[], contestOf: ReadonlyMap<string, Contest>): Block[] {
  const blocks: Block[] = [];
  const contestBlocks = new Map<Contest, Block>();
  for (const result of results) {
    const contest = contestOf.get(result.id);
    if (contest === undefined) {
      const last = blocks.at(-1);
      if (last?.contest === null) last.results.push(result);
      else blocks.push({ contest: null, results: [result] });
      continue;
    }
    const block = contestBlocks.get(contest);
    if (block === undefined) {
      const opened: Block = { contest, results: [result] };
      contestBlocks.set(contest, opened);
      blocks.push(opened);
    } else block.results.push(result);
  }
  return blocks;
}

/**
 * Lays out one runtime's section.
 *
 * @param blocks - The section's blocks, in run order.
 * @param color - Whether to show the heading bold, the rules and column headers dim and each
 *   failure in red.
 * @returns Its heading, then each block, a contest's or one after another block opened by a blank
 *   line.
 */
function sectionLines(blocks: readonly Block[], color: boolean): string[] {
  const first = blocks[0]?.results[0];
  const heading = first === undefined ? "" : `${first.runtime.name} ${first.runtime.version}`;
  return [
    paint("bold", heading, color),
    ...blocks.flatMap((block, index) => {
      const lines =
        block.contest === null
          ? boxLines(PLAIN_COLUMNS, block.results, color)
          : contestLines(block.contest, block.results, color);
      return block.contest === null && index === 0 ? lines : ["", ...lines];
    }),
  ];
}

/**
 * The footer's lines on contests.
 *
 * @param contests - The contests that ran, at least one.
 * @returns How many contests were judged over how many rounds and how to read ranks, or that none
 *   was, then a line per contest that ended with a tie, recommending twice its rounds.
 */
function contestFooter(contests: readonly Contest[]): string[] {
  const judged = contests.filter(({ pairs }) => pairs.length > 0);
  if (judged.length === 0) return [NONE_JUDGED_FOOTER];
  const low = Math.min(...judged.map(({ rounds }) => rounds));
  const high = Math.max(...judged.map(({ rounds }) => rounds));
  const rounds = low === high ? plural(low, "round") : `${String(low)}–${String(high)} rounds`;
  const count = plural(judged.length, "contest");
  const ties = judged
    .filter(({ pairs }) => pairs.some(({ faster }) => faster === null))
    .map(
      ({ name, rounds: tied }) =>
        `${name} ended with a tie: run it with --rounds ${String(2 * tied)} to tell its contenders apart.`,
    );
  return [`${count} judged over ${rounds}. ${JUDGED_FOOTER}`, ...new Set(ties)];
}

/**
 * Formats the table of a run's results, one section per runtime in run order.
 *
 * @param results - The results that finished, in run order.
 * @param contests - The contests that finished; their contenders' results show in a sub-table each.
 * @param options - Whether the stream the table goes to shows color.
 * @returns The table, ending in a newline, or the empty string when there is no result.
 */
export function formatTable(
  results: readonly Result[],
  contests: readonly Contest[],
  options: { readonly color: boolean },
): string {
  if (results.length === 0) return "";
  const { color } = options;
  const byRuntime = Map.groupBy(results, (result) => result.runtime.name);
  const sections = [...byRuntime].map(([runtime, section]) => {
    const contestOf = new Map(
      contests
        .filter((contest) => contest.runtime.name === runtime)
        .flatMap((contest) => contest.contenders.map(({ id }) => [id, contest] as const)),
    );
    return blocksOf(section, contestOf);
  });
  const plainRan = sections.some((blocks) => blocks.some(({ contest }) => contest === null));
  const footer =
    contests.length === 0
      ? [FOOTER]
      : [...contestFooter(contests), ...(plainRan ? [PLAIN_FOOTER] : [])];
  const lines = sections.map((blocks) => sectionLines(blocks, color).join("\n"));
  return `${[...lines, footer.join("\n")].join("\n\n")}\n`;
}
