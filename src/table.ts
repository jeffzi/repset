/**
 * The text a run shows a person: the table of its results.
 *
 * Pure functions from the report's types to text; nothing here prints.
 */
import { stripVTControlCharacters, styleText } from "node:util";

import type { ChildError } from "./child-protocol.js";
import { contestOf } from "./judge.js";
import type { Runtime } from "./measure/runtime.js";
import type { Measure } from "./options.js";
import type { Contest, ContestPair, FailedResult, MeasuredResult, Result } from "./report.js";
import { GRAPHEMES, valueAt } from "./utils.js";

/** Time units from nanoseconds up, each a thousand of the one before. */
const TIME_UNITS = ["ns", "µs", "ms", "s"] as const;

/** Memory units from bytes up, each a thousand of the one before: the SI spelling, as KiB and MiB name 1024 steps. */
const MEMORY_UNITS = ["B", "kB", "MB"] as const;

/** How many of one unit make one of the next. */
const UNIT_STEP = 1000;

const SIGNIFICANT_DIGITS = 3;

const COLUMN_SEPARATOR = " │ ";

const TIME_HEADER = ["median", "mean", "min", "max", "samples"] as const;

const CONTEST_TIME_HEADER = ["median", "ratio", "rank"] as const;

const MEMORY_HEADER = "memory";

/** What a row on a runtime with no heap reading shows in the memory column. */
const NO_HEAP_READING = "n/a";

/** What a row whose memory reading kept no pair free of a collection shows in the memory column. */
const NO_CLEAN_PAIR = "no clean pair";

const COMPARISON_TOOL = "A verdict between revisions takes a comparison tool.";

const FOOTER = `Each case was measured once, in its own process. ${COMPARISON_TOOL}`;

const PLAIN_FOOTER = `Each plain case was measured once, in its own process. ${COMPARISON_TOOL}`;

const NONE_JUDGED_FOOTER =
  "No contest was judged: a verdict needs more repetitions than these contests ran. Without a verdict, these medians do not order the contenders.";

const NONE_FINISHED_FOOTER =
  "No contest was judged: a verdict needs two contenders that finished, and each of these contests had fewer.";

const TOO_FEW_FINISHED = "fewer than two contenders finished";

type Style = "bold" | "dim" | "red" | "green";

type Align = "left" | "right";

/** A run of consecutive plain cases, or one contest's results, within a runtime's section. */
interface Block {
  readonly contest: Contest | null;
  readonly results: Result[];
}

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

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

/** The characters a terminal draws two columns wide: East Asian wide and full-width ones, and emoji. */
const WIDE =
  /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFF}]/u;

/** The columns `text` takes on a terminal: escape codes none, a wide character two, any other one. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(stripVTControlCharacters(text))) {
    width += WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

/** Pads `text` with spaces to `width` terminal columns, on the side `align` names. */
function padTo(text: string, width: number, align: Align): string {
  const fill = " ".repeat(Math.max(0, width - visibleWidth(text)));
  return align === "left" ? `${text}${fill}` : `${fill}${text}`;
}

/** Formats `value` with three significant digits, never in exponent form. */
function significant(value: number): string {
  const text = value.toPrecision(SIGNIFICANT_DIGITS);
  return text.includes("e") ? String(Number(text)) : text;
}

/**
 * Formats `amount` in the first of `units` that keeps three significant digits, up to the last.
 *
 * @param amount - The amount, in the first of `units`; negative keeps its sign.
 * @param units - The units from the smallest up, each {@link UNIT_STEP} of the one before.
 * @returns The amount scaled to its unit, then the unit's name.
 */
function formatIn(amount: number, units: readonly string[]): string {
  let value = amount;
  let unit = 0;
  // Compare the rounded value, so 999.7 ns prints as 1.00 µs rather than 1000 ns.
  while (unit < units.length - 1 && Math.abs(Number(significant(value))) >= UNIT_STEP) {
    value /= UNIT_STEP;
    unit += 1;
  }
  return `${significant(value)} ${units[unit] ?? ""}`;
}

/** Formats a time in nanoseconds in the unit that keeps three significant digits, up to seconds. */
function formatTime(ns: number): string {
  return formatIn(ns, TIME_UNITS);
}

/**
 * The memory column's cell of a measured case.
 *
 * @param result - The measured result.
 * @returns Its bytes per call in the unit that keeps three significant digits, up to megabytes;
 *   `n/a` when its runtime has no heap reading, or `no clean pair` when no pair of samples was free
 *   of a collection.
 */
function memoryCell(result: MeasuredResult): string {
  if (result.memory === null) return NO_HEAP_READING;
  if (result.memory.median === null) return NO_CLEAN_PAIR;
  return formatIn(result.memory.median, MEMORY_UNITS);
}

// ---------------------------------------------------------------------------
// Boxed table layout
// ---------------------------------------------------------------------------

/**
 * The time cells of a measured case's row; the median comes from the result's time, the other
 * statistics from its one measurement.
 *
 * @param result - The measured result.
 * @returns Its median, mean, min, max and sample count, the times per call; none when it was not
 *   timed.
 */
function timeCells(result: MeasuredResult): string[] {
  const { time } = result.measurements[0];
  if (time === null || result.time === null) return [];
  const { stats } = time;
  return [
    formatTime(result.time.median),
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

/** Pads `cell` to the width of `column` in `widths`, on the side `align` names for it. */
function padCell(
  cell: string,
  column: number,
  widths: readonly number[],
  align: readonly Align[],
): string {
  return padTo(cell, widths[column] ?? 0, align[column] ?? "right");
}

/** Lays out `row` in columns of `widths`, each padded on the side `align` names. */
function alignRow(
  row: readonly string[],
  widths: readonly number[],
  align: readonly Align[],
): string {
  return row.map((cell, column) => padCell(cell, column, widths, align)).join(COLUMN_SEPARATOR);
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
 * @param labelWidth - The width the label is padded to.
 * @param color - Whether to show its failure in red.
 * @returns Its row, then each further line of its message, then the labelled lines of its cleanup
 *   teardown's failure when that teardown threw too, each starting where the failure starts.
 */
function failedLines(
  label: string,
  result: FailedResult,
  labelWidth: number,
  color: boolean,
): string[] {
  const labelCell = `${padTo(label, labelWidth, "left")}${COLUMN_SEPARATOR}`;
  const failure = paint("red", `failed in ${result.error.phase}`, color);
  const cellStart = " ".repeat(visibleWidth(labelCell));
  return failureLines(`${labelCell}${failure}: `, result.error, cellStart, cellStart);
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
 * @param color - Whether to show the column header dim and each failure in red.
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
  const headerCells = header.map((cell, column) =>
    paint("dim", padCell(cell, column, widths, align), color),
  );
  return [rule("┬", widths), headerCells.join(COLUMN_SEPARATOR), rule("┼", widths), ...rows];
}

/**
 * The columns of a table: its label column, then the columns each measure adds, memory last.
 *
 * @param label - The label column's header.
 * @param timeHeader - The headers of the columns time adds.
 * @param measure - What the run measured.
 * @returns The headers, every column after the label right-aligned.
 */
function columnsOf(
  label: string,
  timeHeader: readonly string[],
  measure: readonly Measure[],
): Pick<Columns, "header" | "align"> {
  const header = [
    label,
    ...(measure.includes("time") ? timeHeader : []),
    ...(measure.includes("memory") ? [MEMORY_HEADER] : []),
  ];
  return { header, align: header.map((_, column) => (column === 0 ? "left" : "right")) };
}

/** The memory cell of `result`'s row when `measure` holds memory, none otherwise. */
function memoryCells(result: MeasuredResult, measure: readonly Measure[]): string[] {
  return measure.includes("memory") ? [memoryCell(result)] : [];
}

/** The columns of a run of plain cases under `measure`. */
function plainColumns(measure: readonly Measure[]): Columns {
  return {
    ...columnsOf("case", TIME_HEADER, measure),
    cellsOf: (result) => [result.id, ...timeCells(result), ...memoryCells(result, measure)],
    labelOf: ({ id }) => id,
  };
}

// ---------------------------------------------------------------------------
// Contest sub-tables
// ---------------------------------------------------------------------------

/** What a contender's row shows first: its key in the contest, or its case id when it has none. */
function contenderLabel(result: Result): string {
  return result.contender ?? result.id;
}

/**
 * The time cells of a measured contender's row.
 *
 * @param contest - Its contest's entry.
 * @param result - Its result.
 * @returns Its median, then, when the contest was judged, its ratio to the first contender and its
 *   rank; none when it was not timed.
 */
function contenderTimeCells(contest: Contest, result: MeasuredResult): string[] {
  if (result.time === null) return [];
  if (contest.pairs.length === 0) return [formatTime(result.time.median)];
  const entry = contest.contenders.find(({ id }) => id === result.id);
  const ratio = entry?.ratio == null ? "" : `${entry.ratio.toFixed(2)}×`;
  const rank = entry?.rank == null ? "" : String(entry.rank);
  return [formatTime(result.time.median), ratio, rank];
}

/**
 * The lines under a judged contest's sub-table on its tied pairs, each pair named by its
 * contenders' keys.
 *
 * @param contest - The contest's entry.
 * @param results - Its contenders' results, which give each case id its key.
 * @returns A line on the pairs the repetitions did not settle, recommending twice the contest's
 *   repetitions, then a line on the pairs whose gap is within the timer's resolution; a line only
 *   for a kind some pair has.
 */
function tieLines(contest: Contest, results: readonly Result[]): string[] {
  const keyOf = new Map(results.map((result) => [result.id, contenderLabel(result)]));
  const named = (tie: ContestPair["tie"]): string =>
    contest.pairs
      .filter((pair) => pair.tie === tie)
      .map(({ a, b }) => `${keyOf.get(a) ?? a} and ${keyOf.get(b) ?? b}`)
      .join(", ");
  const advice: readonly (readonly [ContestPair["tie"], string])[] = [
    [
      "repetitions",
      `Run it with --contest-repetition-count ${String(2 * contest.repetitionCount)} to tell them apart.`,
    ],
    ["timer", "Their gap is too small for the timer to measure."],
  ];
  return advice.flatMap(([tie, sentence]) => {
    const pairs = named(tie);
    return pairs === "" ? [] : [`tied: ${pairs}. ${sentence}`];
  });
}

/** Whether two or more of `contest`'s contenders finished, as a verdict needs. */
function twoFinished(contest: Contest): boolean {
  return contest.contenders.filter(({ time }) => time !== null).length >= 2;
}

/**
 * The lines under a contest's sub-table on its verdict.
 *
 * @param contest - The contest's entry.
 * @param results - Its contenders' results, in the entry's order.
 * @param repetitions - Its repetitions, as the heading prints them.
 * @returns When the contest was judged, a line per kind of tie its pairs had; when it was not, the
 *   `not judged` line: its repetitions, or that fewer than two contenders finished.
 */
function verdictLines(contest: Contest, results: readonly Result[], repetitions: string): string[] {
  if (contest.pairs.length > 0) return tieLines(contest, results);
  return [`not judged: ${twoFinished(contest) ? repetitions : TOO_FEW_FINISHED}`];
}

/**
 * Lays out one contest's sub-table.
 *
 * @param contest - The contest's entry.
 * @param contestResults - Its contenders' results.
 * @param color - Whether to show the name bold, the repetitions, header and the lines under the
 *   rows dim, and each failure in red.
 * @param measure - What the run measured: the time columns and the verdict lines show only with
 *   time, the memory column only with memory.
 * @returns The contest's name and repetitions, a rule, the column header, a rule, a row per
 *   contender in the entry's order, then, with time, the lines on its verdict.
 */
function contestLines(
  contest: Contest,
  contestResults: readonly Result[],
  color: boolean,
  measure: readonly Measure[],
): string[] {
  const order = contest.contenders.map(({ id }) => id);
  const results = contestResults.toSorted(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
  const timeHeader =
    contest.pairs.length > 0 ? CONTEST_TIME_HEADER : CONTEST_TIME_HEADER.slice(0, 1);
  const { repetitionCount } = contest;
  const repetitions = `${String(repetitionCount)} repetition${repetitionCount === 1 ? "" : "s"}`;
  const verdict = measure.includes("time") ? verdictLines(contest, results, repetitions) : [];
  return [
    `${paint("bold", contest.name, color)}${paint("dim", ` · ${repetitions}`, color)}`,
    ...boxLines(
      {
        ...columnsOf("contender", timeHeader, measure),
        cellsOf: (result) => [
          contenderLabel(result),
          ...contenderTimeCells(contest, result),
          ...memoryCells(result, measure),
        ],
        labelOf: contenderLabel,
      },
      results,
      color,
    ),
    ...verdict.map((line) => paint("dim", line, color)),
  ];
}

// ---------------------------------------------------------------------------
// Sections and the table
// ---------------------------------------------------------------------------

/**
 * Splits a runtime's results into blocks in run order: each contest's results in one block,
 * opened where the first of them ran, and the plain cases between them in blocks of their own.
 *
 * @param results - The runtime's results, in run order.
 * @param contestById - The contest entry of each contender's case id on this runtime.
 * @returns The blocks, in run order.
 */
function blocksOf(results: readonly Result[], contestById: ReadonlyMap<string, Contest>): Block[] {
  const blocks: Block[] = [];
  const contestBlocks = new Map<Contest, Block>();
  for (const result of results) {
    const contest = contestById.get(result.id);
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
 * @param color - Whether to show the heading bold, the column headers dim and each
 *   failure in red.
 * @param measure - What the run measured, which sets each table's columns.
 * @returns Its heading, then each block, a contest's or one after another block opened by a blank
 *   line.
 */
function sectionLines(
  blocks: readonly Block[],
  color: boolean,
  measure: readonly Measure[],
): string[] {
  const first = blocks[0]?.results[0];
  const heading = first === undefined ? "" : `${first.runtime.name} ${first.runtime.version}`;
  return [
    paint("bold", heading, color),
    ...blocks.flatMap((block, index) => {
      const lines =
        block.contest === null
          ? boxLines(plainColumns(measure), block.results, color)
          : contestLines(block.contest, block.results, color, measure);
      return block.contest === null && index === 0 ? lines : ["", ...lines];
    }),
  ];
}

/**
 * The footer lines that say why no contest was judged, none when some contest was.
 *
 * @param contests - The contests that ran, at least one.
 * @returns Nothing when some contest was judged; otherwise that none was, blaming the repetitions
 *   when some contest had two contenders that finished and the failed contenders otherwise.
 */
function contestFooter(contests: readonly Contest[]): string[] {
  if (contests.some(({ pairs }) => pairs.length > 0)) return [];
  return [contests.some(twoFinished) ? NONE_JUDGED_FOOTER : NONE_FINISHED_FOOTER];
}

/** Per runtime, the case ids of the contenders scheduled in a contest there. */
export type ScheduledContests = ReadonlyMap<Runtime, ReadonlySet<string>>;

/**
 * The entries of the contests the stop signal ended on one runtime, built from the results of their
 * contenders that failed before it: such a contest has a result for each, but no entry.
 *
 * @param results - The runtime's results, in run order.
 * @param finished - The entries of the contests that finished on the runtime.
 * @param scheduled - The case ids of the contenders scheduled in a contest on the runtime.
 * @returns An entry per stopped contest, not judged, listing its failed contenders, its repetition
 *   count the last repetition one of them reached.
 */
function stoppedContests(
  results: readonly Result[],
  finished: readonly Contest[],
  scheduled: ReadonlySet<string>,
): Contest[] {
  const entered = new Set(finished.flatMap(({ contenders }) => contenders.map(({ id }) => id)));
  const stopped = results.filter(({ id }) => scheduled.has(id) && !entered.has(id));
  const byBenchmark = Map.groupBy(stopped, ({ file, name }) => JSON.stringify([file, name]));
  return [...byBenchmark.values()].map((contenders) =>
    contestOf([valueAt(contenders, 0), ...contenders.slice(1)]),
  );
}

/**
 * Formats the table of a run's results, one section per runtime in run order.
 *
 * @param results - The results that finished, in run order.
 * @param contests - The contests that finished; their contenders' results show in a sub-table each.
 * @param options - Whether the stream the table goes to shows color; the footer's lines show dim.
 *   `contested` holds, per runtime, the case ids of the contenders scheduled in a contest there,
 *   none by default: a contender's result that no finished contest lists shows in its stopped
 *   contest's sub-table when its id is among them, and as a plain case otherwise. `measure` holds
 *   what the run measured, time alone by default: without time, the time columns and the lines on
 *   contest verdicts are absent; with memory, each measured row ends in a memory column.
 * @returns The table, then the footer after a blank line when it has anything to say, ending in a
 *   newline, or the empty string when there is no result.
 */
export function formatTable(
  results: readonly Result[],
  contests: readonly Contest[],
  options: {
    readonly color: boolean;
    readonly contested?: ScheduledContests;
    readonly measure?: readonly Measure[];
  },
): string {
  if (results.length === 0) return "";
  const { color, contested, measure = ["time"] } = options;
  const byRuntime = Map.groupBy(results, (result) => result.runtime.name);
  const ran = [...byRuntime].map(([runtime, section]) => {
    const finished = contests.filter((contest) => contest.runtime.name === runtime);
    const stopped = stoppedContests(
      section,
      finished,
      contested?.get(runtime) ?? new Set<string>(),
    );
    const contestById = new Map(
      [...finished, ...stopped].flatMap((contest) =>
        contest.contenders.map(({ id }) => [id, contest] as const),
      ),
    );
    return { blocks: blocksOf(section, contestById), stopped };
  });
  const sections = ran.map(({ blocks }) => blocks);
  const shown = [...contests, ...ran.flatMap(({ stopped }) => stopped)];
  const plainRan = sections.some((blocks) => blocks.some(({ contest }) => contest === null));
  const verdicts = measure.includes("time") ? contestFooter(shown) : [];
  const footer = shown.length === 0 ? [FOOTER] : [...verdicts, ...(plainRan ? [PLAIN_FOOTER] : [])];
  const lines = sections.map((blocks) => sectionLines(blocks, color, measure).join("\n"));
  const footerBlock = footer.map((line) => paint("dim", line, color)).join("\n");
  const blocks = footer.length > 0 ? [...lines, footerBlock] : lines;
  return `${blocks.join("\n\n")}\n`;
}
