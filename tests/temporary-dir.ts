import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, onTestFinished } from "vitest";

function createDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A fresh directory named from `prefix`, removed when the test ends. */
export function temporaryDir(prefix: string): string {
  const dir = createDir(prefix);
  onTestFinished(() => {
    removeDir(dir);
  });
  return dir;
}

/** A fresh directory named from `prefix`, created before the suite's tests and removed after them. */
export function suiteTemporaryDir(prefix: string): { readonly path: string } {
  let dir = "";
  beforeAll(() => {
    dir = createDir(prefix);
  });
  afterAll(() => {
    removeDir(dir);
  });
  return {
    get path(): string {
      return dir;
    },
  };
}
