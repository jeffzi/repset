import { readFileSync } from "node:fs";

import type { Report } from "../src/report.js";

/** Whether `value` is a non-null object. */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Whether `value` is a schema-1 report document, checked on the keys the tests read. */
function isReport(value: unknown): value is Report {
  if (!isObject(value)) return false;
  const field = (key: string): unknown => Reflect.get(value, key);
  return (
    field("schema") === 1 &&
    isObject(field("options")) &&
    Array.isArray(field("results")) &&
    Array.isArray(field("contests")) &&
    typeof field("interrupted") === "boolean"
  );
}

/** The schema-1 report the JSON `text` holds; throws naming `source` when it holds none. */
export function parseReport(text: string, source: string): Report {
  const parsed: unknown = JSON.parse(text);
  if (!isReport(parsed)) throw new Error(`${source} does not hold a schema-1 report`);
  return parsed;
}

/** The report the file at `path` holds. */
export function reportAt(path: string): Report {
  return parseReport(readFileSync(path, "utf8"), path);
}
