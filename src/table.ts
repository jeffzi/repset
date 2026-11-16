/**
 * The text a run shows a person: the table of its results, and the metric line of each result.
 *
 * Pure functions from the report's types to text; nothing here prints.
 */
import type { TeardownFailure } from "./child.js";
import type { FailedResult, MeasuredResult, Result } from "./report.js";

/** Time units from nanoseconds up, each a thousand of the one before. */
const TIME_UNITS = ["ns", "µs", "ms", "s"] as const;

/** How many of one time unit make one of the next. */
const UNIT_STEP = 1000;

const SIGNIFICANT_DIGITS = 3;

const COLUMN_GAP = "  ";

const ROW_INDENT = "  ";

const HEADER = ["case", "median", "mean", "min", "max", "samples"] as const;

const FOOTER =
  "Each case was measured once, in its own process. A verdict between revisions takes a comparison tool.";

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
 * The cells of a measured case's row.
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

/** Lays out `rows` in columns: the first left-aligned, the rest right-aligned. */
function alignRows(rows: readonly (readonly string[])[], idWidth: number): string[] {
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(idWidth) : cell.padStart(widths[column] ?? 0),
      )
      .join(COLUMN_GAP),
  );
}

const TEARDOWN_LABEL = "teardown also failed: ";

/** `message` after `lead`, each further line of it beneath its first. */
function leadLines(lead: string, message: string): string[] {
  const [first = "", ...rest] = message.split("\n");
  const continuation = " ".repeat(lead.length);
  return [`${lead}${first}`, ...rest.map((line) => `${continuation}${line}`)];
}

/**
 * The labelled lines of a cleanup teardown's failure, shown beneath the failure it cleaned up after.
 *
 * @param teardownError - The teardown's failure.
 * @param indent - What opens the first line: the column the lines start at.
 * @returns The label and the teardown's message, each further line of the message beneath its first.
 */
export function teardownLines(teardownError: TeardownFailure, indent: string): string[] {
  return leadLines(`${indent}${TEARDOWN_LABEL}`, teardownError.message);
}

/**
 * The lines of a failed case: its row, then each further line of its message beneath it, then the
 * labelled lines of its cleanup teardown's failure when that teardown threw too.
 */
function failedLines(result: FailedResult, idWidth: number): string[] {
  const lead = `${result.id.padEnd(idWidth)}${COLUMN_GAP}failed in ${result.error.phase}: `;
  const { message, teardownError } = result.error;
  const teardown =
    teardownError === null ? [] : teardownLines(teardownError, " ".repeat(lead.length));
  return [...leadLines(lead, message), ...teardown];
}

/** The lines of one runtime's section: its heading, the column header, then a row per case. */
function sectionLines(results: readonly Result[]): string[] {
  const measuredRows = results.flatMap((result) =>
    result.status === "ok" ? [measuredCells(result)] : [],
  );
  const idWidth = Math.max(HEADER[0].length, ...results.map((result) => result.id.length));
  const [header = "", ...rows] = alignRows([HEADER, ...measuredRows], idWidth);
  const alignedRows = rows.values();
  const caseLines = results.flatMap((result) =>
    result.status === "ok" ? [alignedRows.next().value ?? ""] : failedLines(result, idWidth),
  );
  const first = results[0];
  const heading = first === undefined ? "" : `${first.runtime.name} ${first.runtime.version}`;
  return [heading, ...[header, ...caseLines].map((line) => `${ROW_INDENT}${line}`)];
}

/**
 * Formats the table of a run's results, one section per runtime in run order.
 *
 * @param results - The results that finished, in run order.
 * @returns The table, ending in a newline, or the empty string when there is no result.
 */
export function formatTable(results: readonly Result[]): string {
  if (results.length === 0) return "";
  const byRuntime = Map.groupBy(results, (result) => result.runtime.name);
  const sections = [...byRuntime.values()].map((section) => sectionLines(section).join("\n"));
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
