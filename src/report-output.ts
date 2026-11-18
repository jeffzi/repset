/**
 * The report's output: the JSON text a file or stdout holds, and the file `--out` names, always
 * holding a whole report.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { failedWith } from "./options.js";
import type { Report } from "./report.js";
import type { RunInput } from "./run.js";

/** The report as a file or stdout holds it: JSON indented by two spaces, and a newline. */
export function reportText(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Writes `report` to `path` through a temporary file in the same directory renamed over it, so
 * the file always holds a whole report, creating the directory first when it is missing.
 *
 * @param path - The report file, as an absolute path.
 * @param report - The report to write.
 * @throws {Error} The error creating the directory or writing or renaming the file; the temporary
 *   file is removed first.
 */
export function writeReport(path: string, report: Report): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, reportText(report));
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The callbacks that write the report while the run goes on, when `--out` names a file. */
export function reportWrites(
  path: string,
  shown: string,
): Pick<RunInput, "onSelected" | "onResult"> {
  let current: Report | undefined;
  return {
    onSelected: (head) => {
      current = head;
      try {
        writeReport(path, head);
      } catch (error) {
        throw failedWith(`cannot write the report to ${shown}`, error);
      }
    },
    onResult: (result) => {
      if (current === undefined) return;
      current = { ...current, results: [...current.results, result] };
      try {
        writeReport(path, current);
      } catch {
        // The run goes on: the write when the run ends either repairs the file or reports the
        // failure, so a failure here has nothing left to tell.
      }
    },
  };
}
