import { describe, expect, it } from "vitest";

import type { ChildRequest, MeasureRequest } from "../src/child-protocol.js";
import { readResult } from "../src/child-result.js";
import { errorOf } from "./helpers/error-of.js";

/** A list request; `readResult` reads only its mode. */
const LIST: ChildRequest = { mode: "list", file: "fruit.bench.ts" };

/** A once request; `readResult` reads only its mode. */
const ONCE: ChildRequest = { mode: "once", file: "fruit.bench.ts", id: "apple" };

/** What a measure request asks the child to read. */
type Asked = Pick<MeasureRequest, "time" | "memory">;

const TIME_ONLY: Asked = { time: true, memory: false };

const MEMORY_ONLY: Asked = { time: false, memory: true };

/** A measure request asking for `asked`. */
function measuring(asked: Asked = TIME_ONLY): MeasureRequest {
  return {
    mode: "measure",
    file: "fruit.bench.ts",
    id: "apple",
    minTime: 5,
    minSamples: 8,
    ...asked,
  };
}

/** Listed cases as the parent accepts them: `contender` is `null` for a plain benchmark and the key for a contender. */
const LISTED_APPLE = { id: "apple", setupPerCall: false, name: "apple", contender: null } as const;

/** A listed contender of the benchmark `sort`. */
const LISTED_QUICK = {
  id: "sort/quick",
  setupPerCall: false,
  name: "sort",
  contender: "quick",
} as const;

/** The result line of a listing whose one case is `listedCase`. */
function listingLine(listedCase: object): string {
  return `${JSON.stringify({ status: "ok", cases: [listedCase] })}\n`;
}

/** The result line of a child whose own failure is `error`. */
function failureLine(error: object): string {
  return `${JSON.stringify({ status: "failed", error })}\n`;
}

/** The fields of a child's own failure in phase fn, before its `teardownError`. */
const FN_KIWI = { phase: "fn", message: "kiwi", stack: "at fn" } as const;

/** The collections a measurement on Node reports, as the child writes them. */
const NODE_GC = {
  collectionCount: 3,
  durationMs: 0.5,
  maxDurationMs: 0.25,
  nodeMinorCollectionCount: 2,
  nodeMajorCollectionCount: 1,
} as const;

/** A `time` block, complete in every field, with the given `gc`. */
function timeBlock(gc: object | null): object {
  return {
    stats: { min: 1, p25: 1, median: 1, p75: 1, p99: 1, max: 1, mean: 1, sampleCount: 8 },
    sampling: {
      timerResolutionNs: 1,
      callsPerSample: 1,
      warmupSampleCount: 1,
      timingAttemptCount: 1,
      timingMs: 5,
      callsPerSampleFixed: false,
    },
    checks: { ratioToEmptyBody: 1 },
    gc,
    rawSamples: null,
  };
}

/** Statistics complete in every field, as a `memory` block holds them. */
const MEMORY_STATS = {
  min: 40,
  p25: 40,
  median: 40,
  p75: 40,
  p99: 40,
  max: 40,
  mean: 40,
  sampleCount: 21,
} as const;

/** A `memory` block, complete in every field, with the given `stats`. */
function memoryBlock(stats: object | null): object {
  return { stats, sampling: { callsPerSample: 64 }, rawSamples: null };
}

/** The result line of a measurement with the given `status` and fields. */
function measuredLine(status: string, fields: object): string {
  return `${JSON.stringify({ status, ...fields })}\n`;
}

describe("readResult", () => {
  describe("when the line answers its request", () => {
    it.each([
      {
        why: "a listing",
        written: listingLine(LISTED_APPLE),
        request: LIST,
        expected: { status: "ok", cases: [LISTED_APPLE] },
      },
      {
        why: "a listing of a contender",
        written: listingLine(LISTED_QUICK),
        request: LIST,
        expected: { status: "ok", cases: [LISTED_QUICK] },
      },
      {
        why: "the child's own failure with no stack",
        written: failureLine({ phase: "load", message: "kiwi", stack: null, teardownError: null }),
        request: ONCE,
        expected: {
          status: "failed",
          error: { phase: "load", message: "kiwi", stack: null, teardownError: null },
        },
      },
    ])("returns $why", ({ written, request, expected }) => {
      const result = readResult(written, request);

      expect(result).toStrictEqual(expected);
    });

    it("returns a measurement holding its collections", () => {
      const written = measuredLine("ok", { time: timeBlock(NODE_GC), memory: null });

      const result = readResult(written, measuring());

      expect(result).toStrictEqual(
        expect.objectContaining({ time: expect.objectContaining({ gc: NODE_GC }) }),
      );
    });

    it.each([
      {
        why: "time and memory blocks for a request asking both",
        fields: { time: timeBlock(null), memory: memoryBlock(MEMORY_STATS) },
        asked: { time: true, memory: true },
      },
      {
        why: "a null time and a memory block for a request asking memory alone",
        fields: { time: null, memory: memoryBlock(MEMORY_STATS) },
        asked: MEMORY_ONLY,
      },
      {
        why: "a memory block whose statistics are null, no pair having been clean",
        fields: { time: null, memory: memoryBlock(null) },
        asked: MEMORY_ONLY,
      },
      {
        why: "a null time and a null memory for a request asking memory alone, as on Bun",
        fields: { time: null, memory: null },
        asked: MEMORY_ONLY,
      },
    ])("returns a measurement with $why", ({ fields, asked }) => {
      const result = readResult(measuredLine("ok", fields), measuring(asked));

      expect(result).toStrictEqual({ status: "ok", ...fields });
    });
  });

  describe("when the line is not a usable result", () => {
    it.each([
      {
        why: "a line with no newline",
        written: listingLine(LISTED_APPLE).trimEnd(),
        request: LIST,
      },
      {
        why: "a listing for a measure request",
        written: listingLine(LISTED_APPLE),
        request: measuring(),
      },
      { why: "a listing for a once request", written: listingLine(LISTED_APPLE), request: ONCE },
      {
        why: "a listing whose case has no name",
        written: listingLine({ ...LISTED_APPLE, name: undefined }),
        request: LIST,
      },
      {
        why: "a listing whose case's contender is a number",
        written: listingLine({ ...LISTED_APPLE, contender: 7 }),
        request: LIST,
      },
      {
        why: "a failure with no message",
        written: failureLine({ phase: "fn", stack: null, teardownError: null }),
        request: ONCE,
      },
      { why: "a failure with no teardownError", written: failureLine(FN_KIWI), request: ONCE },
      {
        why: "a measurement whose collections lack the major count",
        written: measuredLine("ok", {
          time: timeBlock({ ...NODE_GC, nodeMajorCollectionCount: undefined }),
          memory: null,
        }),
        request: measuring(),
      },
      {
        why: "a failure whose teardownError has no stack",
        written: failureLine({ ...FN_KIWI, teardownError: { message: "melon" } }),
        request: ONCE,
      },
    ])("returns what is wrong for $why", ({ written, request }) => {
      const result = readResult(written, request);

      expect(result).toStrictEqual(expect.any(String));
    });

    it.each([
      {
        why: "a null time for a request asking time",
        fields: { time: null, memory: null },
        asked: TIME_ONLY,
      },
      {
        why: "a time block for a request not asking time",
        fields: { time: timeBlock(null), memory: memoryBlock(MEMORY_STATS) },
        asked: MEMORY_ONLY,
      },
      {
        why: "a memory block for a request not asking memory",
        fields: { time: timeBlock(null), memory: memoryBlock(MEMORY_STATS) },
        asked: TIME_ONLY,
      },
      {
        why: "no memory at all",
        fields: { time: timeBlock(null), memory: undefined },
        asked: TIME_ONLY,
      },
      {
        why: "no memory at all for a request asking memory",
        fields: { time: null, memory: undefined },
        asked: MEMORY_ONLY,
      },
      {
        why: "a memory block holding raw samples",
        fields: { time: null, memory: { ...memoryBlock(MEMORY_STATS), rawSamples: [] } },
        asked: MEMORY_ONLY,
      },
      {
        why: "a memory block with no calls per sample",
        fields: { time: null, memory: { stats: MEMORY_STATS, sampling: {}, rawSamples: null } },
        asked: MEMORY_ONLY,
      },
      {
        why: "a memory block whose statistics lack the sample count",
        fields: { time: null, memory: memoryBlock({ ...MEMORY_STATS, sampleCount: undefined }) },
        asked: MEMORY_ONLY,
      },
    ])("returns what is wrong for $why", ({ fields, asked }) => {
      const result = readResult(measuredLine("ok", fields), measuring(asked));

      expect(result).toStrictEqual(expect.any(String));
    });

    it("names the measure request when the measurement's status is neither ok nor failed", () => {
      const written = measuredLine("pear", { time: timeBlock(null), memory: null });

      const result = readResult(written, measuring());

      expect(result).toStrictEqual(expect.stringMatching(/\bmeasure\b/u));
    });

    it("carries the parse error of a line that is not JSON", () => {
      const parseError = errorOf(() => JSON.parse("banana"));

      const result = readResult("banana\n", LIST);

      expect(result).toStrictEqual(expect.stringContaining(parseError.message));
    });

    it("counts the lines of a child that wrote more than one", () => {
      const line = listingLine(LISTED_APPLE);

      const result = readResult(`${line}${line}`, LIST);

      expect(result).toStrictEqual(expect.stringMatching(/\b2\b/u));
    });

    it("quotes the first 200 characters of a line that does not answer its request", () => {
      const written = `${JSON.stringify({ status: "ok", pear: "x".repeat(300) })}\n`;

      const result = readResult(written, LIST);

      expect(result).toStrictEqual(expect.stringMatching(/\{"status":"ok","pear":"x{177}$/u));
    });
  });
});
