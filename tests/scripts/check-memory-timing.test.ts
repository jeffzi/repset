import { describe, expect, it } from "vitest";

import { runCheck } from "../../scripts/check-memory-timing.js";
import type { Readers } from "../../scripts/check-memory-timing.js";
import { READING } from "../helpers/repset-reading.js";
import { wordsInOrder } from "../helpers/words-in-order.js";

/** Readers for every body: the same reading with memory measured as without. */
const READERS: Readers = {
  alone: () => READING,
  withMemory: () => READING,
};

/** The median every body's timing alone reads in the printing tests. */
const ALONE = 1000.123_456_789;

/** Matchers for a round's 12 pair lines, the pair at `index` reading `withMemory(index)` with memory measured. */
function pairLines(body: string, round: string, withMemory: (index: number) => number): unknown[] {
  return Array.from({ length: 12 }, (_, index) =>
    expect.stringMatching(
      wordsInOrder(body, round, index + 1, "time", ALONE, "time,memory", withMemory(index)),
    ),
  );
}

/** Matches a round's summary line: the body, the round, both medians and the gap in percent. */
function summaryLine(body: string, round: string, withMemoryMedian: number): unknown {
  const gapPercent = ((withMemoryMedian - ALONE) / ALONE) * 100;
  return expect.stringMatching(
    wordsInOrder(
      body,
      round,
      "time",
      ALONE.toFixed(1),
      "time,memory",
      withMemoryMedian.toFixed(1),
      gapPercent.toFixed(2),
    ),
  );
}

/** Runs the check, returning the bodies in the order first read and each body's printed lines. */
function printedLines(withMemory: () => number): { bodies: string[]; lines: string[][] } {
  const bodies: string[] = [];
  const readers: Readers = {
    alone: (body) => {
      if (!bodies.includes(body)) bodies.push(body);
      return { ...READING, median: ALONE };
    },
    withMemory: () => ({ ...READING, median: withMemory() }),
  };
  const printed: string[] = [];
  runCheck(readers, (text) => {
    printed.push(text);
  });
  return { bodies, lines: printed.map((text) => text.split("\n")) };
}

describe("runCheck", () => {
  describe("when no body's timing differs with memory measured", () => {
    it("returns 0", () => {
      const status = runCheck(READERS, () => undefined);

      expect(status).toBe(0);
    });

    it("prints the round's summary then one line per pair naming the body, round, pair and both medians", () => {
      const above = ALONE + 0.5;
      const below = ALONE - 0.5;
      let calls = 0;
      const withMemoryAt = (index: number): number => (index % 2 === 0 ? above : below);

      const { bodies, lines } = printedLines(() => withMemoryAt(calls++));

      expect(lines).toStrictEqual(
        bodies.map((body) =>
          [summaryLine(body, "first", ALONE)].concat(pairLines(body, "first", withMemoryAt), [
            expect.stringMatching(wordsInOrder(body, "pass")),
          ]),
        ),
      );
    });
  });

  describe("when timing with memory measured reads higher than timing alone in every pair", () => {
    it("returns 1", () => {
      const readers: Readers = {
        alone: () => READING,
        withMemory: () => ({ ...READING, median: 1100 }),
      };

      const status = runCheck(readers, () => undefined);

      expect(status).toBe(1);
    });

    it("prints both rounds' summary and pair lines, then the verdict", () => {
      const first = 1100.987_654_321;
      const confirmation = 1200.456_789_123;
      let calls = 0;

      const { bodies, lines } = printedLines(() => (calls++ % 24 < 12 ? first : confirmation));

      expect(lines).toStrictEqual(
        bodies.map((body) =>
          [summaryLine(body, "first", first)].concat(
            pairLines(body, "first", () => first),
            [summaryLine(body, "confirmation", confirmation)],
            pairLines(body, "confirmation", () => confirmation),
            [expect.stringMatching(wordsInOrder(body, "FAIL"))],
          ),
        ),
      );
    });
  });
});
