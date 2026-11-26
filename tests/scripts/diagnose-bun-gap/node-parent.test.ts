import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fixturePath, ROOT } from "../../helpers/fixture-path.js";
import { requiresRealBunHere } from "../../helpers/real-bun.js";
import { POSIX, SPAWN_TIMEOUT_MS } from "../../helpers/spawn-limits.js";

const NODE_PARENT = join(ROOT, "scripts", "diagnose-bun-gap", "node-parent.ts");

/** Runs node-parent under this Node on `script` with `args`, from the repository root. */
function runNodeParent(script: string, ...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [NODE_PARENT, script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

describe.runIf(requiresRealBunHere())("node-parent", () => {
  describe("when the Bun child exits on its own", () => {
    it(
      "relays the child's stdout and exits with its status",
      () => {
        const script = fixturePath("children", "print-then-exit.ts");

        const result = runNodeParent(script, "3");

        expect({ stdout: result.stdout, status: result.status }).toStrictEqual({
          stdout: "plum\n",
          status: 3,
        });
      },
      SPAWN_TIMEOUT_MS,
    );
  });

  describe("when a signal ends the Bun child", () => {
    it.runIf(POSIX)(
      "exits non-zero naming the script on stderr",
      () => {
        const script = fixturePath("children", "kill-self.ts");

        const result = runNodeParent(script);

        expect(result.status).toBeGreaterThan(0);
        expect(result.stderr).toContain(script);
      },
      SPAWN_TIMEOUT_MS,
    );
  });
});
