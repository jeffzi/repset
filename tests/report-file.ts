import { readFileSync } from "node:fs";

import type { Report } from "../src/report.js";

/** Whether `value` is a schema-1 report document, checked on the keys the tests read. */
function isReport(value: unknown): value is Report {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === 1 &&
    "options" in value &&
    typeof value.options === "object" &&
    value.options !== null &&
    "results" in value &&
    Array.isArray(value.results) &&
    "interrupted" in value &&
    typeof value.interrupted === "boolean"
  );
}

/**
 * The report `text` holds.
 *
 * @param text - The JSON the command wrote.
 * @param source - Names where `text` came from in the error thrown when it holds no report.
 * @returns The parsed report.
 * @throws When `text` is not JSON, or holds no schema-1 report.
 */
export function parseReport(text: string, source: string): Report {
  const parsed: unknown = JSON.parse(text);
  if (!isReport(parsed)) throw new Error(`${source} does not hold a schema-1 report`);
  return parsed;
}

/** The report the file at `path` holds. */
export function reportAt(path: string): Report {
  return parseReport(readFileSync(path, "utf8"), path);
}
