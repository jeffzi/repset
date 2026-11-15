import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, onTestFinished } from "vitest";

/** A fresh directory named from `prefix`, removed when the test ends. */
export function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A fresh directory named from `prefix`, created before the suite's tests and removed after them. */
export function suiteTemporaryDir(prefix: string): { readonly path: string } {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get path(): string {
      return dir;
    },
  };
}
