import { beforeEach, describe, expect, it } from "vitest";

import type { Outcome } from "../src/children.js";
import {
  captured,
  clearShellEnv,
  command,
  measuresAll,
  starter,
  workspace,
} from "./command-harness.js";

const FILES = ["sort.bench.ts", "parse.bench.ts"];

/** The stack of the Error `sort/fast` throws. */
const STACK = "Error: kiwi\n    at plum (sort.bench.ts:3:9)";

/** What `sort/fast`'s child printed before it failed. */
const OUTPUT = "pear\nfig\n";

const SORT_FAILED: Outcome = {
  status: "failed",
  error: { phase: "fn", message: "kiwi", stack: STACK, teardownError: null },
  output: OUTPUT,
};

/** A child starter that fails `sort/fast` with {@link STACK} and {@link OUTPUT}, keeping in `seen` what stderr held as `parse/fast` started. */
function failsSort(stderr: { readonly text: string }, seen: string[]): ReturnType<typeof starter> {
  return starter((request, runtime, options) => {
    if (request.id === "sort/fast") return SORT_FAILED;
    seen.push(stderr.text);
    return measuresAll(runtime, request, options);
  });
}

/** Whether `text` holds the failed case's stack and its child's output. */
function holdsFailure(text: string): { stack: boolean; output: boolean } {
  return { stack: text.includes(STACK), output: text.includes(OUTPUT) };
}

describe("main", () => {
  beforeEach(() => {
    clearShellEnv();
  });

  describe("when debug is on", () => {
    it.each([
      { run: "a measuring run", args: [] },
      { run: "a --once run", args: ["--once"] },
    ])(
      "writes a failed case's stack and its child's output to stderr when the case fails, in $run",
      async ({ args }) => {
        const stderr = captured();
        const seen: string[] = [];

        await command(workspace(), [...args, "--debug", ...FILES], {
          stderr,
          startChild: failsSort(stderr, seen),
        });

        expect(seen.map(holdsFailure)).toStrictEqual([{ stack: true, output: true }]);
      },
    );
  });

  describe("when debug is off", () => {
    it("writes neither a failed case's stack nor its child's output to stderr", async () => {
      const stderr = captured();

      await command(workspace(), FILES, { stderr, startChild: failsSort(stderr, []) });

      expect(holdsFailure(stderr.text)).toStrictEqual({ stack: false, output: false });
    });
  });

  it("prints the same stdout with debug on and off", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      const stderr = captured();
      const { stdout } = await command(workspace(), [...args, ...FILES], {
        stderr,
        startChild: failsSort(stderr, []),
      });
      return stdout;
    };

    const [off, on] = await Promise.all([run([]), run(["--debug"])]);

    expect({ printed: off.length > 0, on }).toStrictEqual({ printed: true, on: off });
  });
});
