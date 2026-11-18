/**
 * The text a run shows a person: the table of its results, and the metric line of each result.
 *
 * Pure functions from the report's types to text; nothing here prints.
 */
import { stripVTControlCharacters, styleText } from "node:util";

import type { ChildError } from "./child.js";
import type { FailedResult, MeasuredResult, Result } from "./report.js";

/** Time units from nanoseconds up, each a thousand of the one before. */
const TIME_UNITS = ["ns", "µs", "ms", "s"] as const;

/** How many of one time unit make one of the next. */
const UNIT_STEP = 1000;

const SIGNIFICANT_DIGITS = 3;

const COLUMN_SEPARATOR = " │ ";

const HEADER = ["case", "median", "mean", "min", "max", "samples"] as const;

const FOOTER =
  "Each case was measured once, in its own process. A verdict between revisions takes a comparison tool.";

export type Style = "bold" | "dim" | "red" | "green";

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

/** The width of each column: `idWidth` for the first, the widest cell of `rows` for the rest. */
function columnWidths(rows: readonly (readonly string[])[], idWidth: number): number[] {
  return HEADER.map((_, column) =>
    column === 0 ? idWidth : Math.max(...rows.map((row) => visibleWidth(row[column] ?? ""))),
  );
}

/** Lays out `row` in columns of `widths`: the first left-aligned, the rest right-aligned. */
function alignRow(row: readonly string[], widths: readonly number[]): string {
  return row
    .map((cell, column) => {
      const width = widths[column] ?? 0;
      return column === 0 ? cell.padEnd(width) : cell.padStart(width);
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
 * Formats a failed case as a row whose failure spans the columns after its id.
 *
 * @param result - The failed result.
 * @param idWidth - The width the case id is padded to.
 * @param color - Whether to show its failure in red.
 * @returns Its row, then each further line of its message, then the labelled lines of its cleanup
 *   teardown's failure when that teardown threw too, each starting where the failure starts.
 */
function failedLines(result: FailedResult, idWidth: number, color: boolean): string[] {
  const idCell = `${result.id.padEnd(idWidth)}${COLUMN_SEPARATOR}`;
  const failure = paint("red", `failed in ${result.error.phase}`, color);
  const cellStart = " ".repeat(visibleWidth(idCell));
  return failureLines(`${idCell}${failure}: `, result.error, cellStart, cellStart);
}

/**
 * Lays out one runtime's section.
 *
 * @param results - The section's results, in run order.
 * @param color - Whether to show the heading bold, the rules and column header dim and each failure
 *   in red.
 * @returns Its heading, a rule, the column header, a rule, then a row per case.
 */
function sectionLines(results: readonly Result[], color: boolean): string[] {
  const idWidth = Math.max(HEADER[0].length, ...results.map((result) => result.id.length));
  const cells = results.map((result) => (result.status === "ok" ? measuredCells(result) : []));
  const widths = columnWidths([HEADER, ...cells], idWidth);
  const caseLines = results.flatMap((result, index) =>
    result.status === "ok"
      ? [alignRow(cells[index] ?? [], widths)]
      : failedLines(result, idWidth, color),
  );
  const first = results[0];
  const heading = first === undefined ? "" : `${first.runtime.name} ${first.runtime.version}`;
  return [
    paint("bold", heading, color),
    paint("dim", rule("┬", widths), color),
    paint("dim", alignRow(HEADER, widths), color),
    paint("dim", rule("┼", widths), color),
    ...caseLines,
  ];
}

/**
 * Formats the table of a run's results, one section per runtime in run order.
 *
 * @param results - The results that finished, in run order.
 * @param options - Whether the stream the table goes to shows color; plain when absent.
 * @returns The table, ending in a newline, or the empty string when there is no result.
 */
export function formatTable(
  results: readonly Result[],
  options: { readonly color?: boolean } = {},
): string {
  if (results.length === 0) return "";
  const color = options.color === true;
  const byRuntime = Map.groupBy(results, (result) => result.runtime.name);
  const sections = [...byRuntime.values()].map((section) =>
    sectionLines(section, color).join("\n"),
  );
  return `${[...sections, FOOTER].join("\n\n")}\n`;
}

/**
 * The line a tool that reads metrics from stdout takes a measured case's median from.
 *
 * @param result - A result that finished.
 * @returns `METRIC <case id>/runtime=<runtime>#time=<median>`, the median in nanoseconds per call
 *   as its shortest round-trip text, or `undefined` for a failed result, which has no median.
 */
export function metricLine(result: Result): string | undefined {
  if (result.status === "failed") return undefined;
  return `METRIC ${result.id}/runtime=${result.runtime.name}#time=${String(result.median)}`;
}
