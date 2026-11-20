import { readFileSync } from "node:fs";

import type { Report } from "../src/report.js";
import { isRecord } from "../src/utils.js";

/** Whether `value` is a non-null object. */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Whether `value` is a schema-1 report document, checked on the keys the tests read. */
function isReport(value: unknown): value is Report {
  if (!isRecord(value)) return false;
  return (
    value["schema"] === 1 &&
    isObject(value["options"]) &&
    Array.isArray(value["results"]) &&
    Array.isArray(value["contests"]) &&
    typeof value["interrupted"] === "boolean"
  );
}

/**
 * Parses `text` as a schema-1 report document.
 *
 * @param text - The JSON text of the report.
 * @param source - What `text` came from, named in the error when it holds no report.
 * @returns The parsed report.
 * @throws SyntaxError When `text` is not valid JSON.
 * @throws Error When the parsed document is not a schema-1 report; the message names `source`.
 */
export function parseReport(text: string, source: string): Report {
  const parsed: unknown = JSON.parse(text);
  if (!isReport(parsed)) throw new Error(`${source} does not hold a schema-1 report`);
  return parsed;
}

/**
 * Reads the schema-1 report stored in a JSON file.
 *
 * @param path - The file to read.
 * @returns The report the file holds.
 * @throws Error The `readFileSync` error when the file cannot be read.
 * @throws SyntaxError When the file is not valid JSON.
 * @throws Error When the file does not hold a schema-1 report; the message names `path`.
 */
export function reportAt(path: string): Report {
  return parseReport(readFileSync(path, "utf8"), path);
}
