import { describe, expect, it } from "vitest";

import { contestOf, hodgesLehmann, holm, signedRankInterval, signedRankP } from "../src/judge.js";
import type {
  CaseMeasurement,
  ContestPair,
  FailedResult,
  HeadlineMemory,
  MeasuredResult,
  Result,
} from "../src/report.js";
import { errorOf } from "./helpers/error-of.js";
import { measured, memoryOf, runtimeOf } from "./helpers/fake-children.js";
import { repeated } from "./helpers/repeated.js";
import { bytesPerCall, nsPerCall } from "./helpers/report-results.js";
import { wordsInOrder } from "./helpers/words-in-order.js";

/** What a contender's child gave in one repetition: its median, or its median at a calls per sample. */
type Timing = number | { readonly median: number; readonly callsPerSample: number };

/** What every result of contender `key` of contest `concat` on Node holds. */
function base(
  key: string,
): Pick<Result, "id" | "name" | "contender" | "params" | "file" | "runtime" | "setupPerCall"> {
  return {
    id: `concat/${key}`,
    name: "concat",
    contender: key,
    params: {},
    file: "concat.bench.ts",
    runtime: runtimeOf("node"),
    setupPerCall: false,
  };
}

/** The measurement of repetition `repetition` timed at `timing`, 41.7 ns timer and 2 calls per sample unless given. */
function timedIn(repetition: number, timing: Timing): CaseMeasurement {
  const { median, callsPerSample = 2 } = typeof timing === "number" ? { median: timing } : timing;
  const { time } = measured(median);
  return {
    repetition,
    orderInRepetition: 1,
    time: { ...time, sampling: { ...time.sampling, callsPerSample } },
    memory: null,
  };
}

/** The median of `values`, as a run takes a contender's headline time from its repetitions. */
function medianOf(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

/** Contender `key`, timed in repetition `i + 1` at `timings[i]`, reading `memory`. */
function timed(
  key: string,
  timings: readonly Timing[],
  memory: HeadlineMemory | null = null,
): MeasuredResult {
  const [first, ...rest] = timings.map((timing, index) => timedIn(index + 1, timing));
  if (first === undefined) throw new RangeError("a timed contender needs one repetition");
  const medians = timings.map((timing) => (typeof timing === "number" ? timing : timing.median));
  return {
    ...base(key),
    status: "ok",
    error: null,
    time: { unit: "ns/call", median: medianOf(medians) },
    memory,
    measurements: [first, ...rest],
  };
}

/** Contender `key`, timed at `median` in each repetition of `repetitions`. */
function timedOver(key: string, repetitions: readonly number[], median: number): MeasuredResult {
  const [first, ...rest] = repetitions.map((repetition) => timedIn(repetition, median));
  if (first === undefined) throw new RangeError("a timed contender needs one repetition");
  return {
    ...base(key),
    status: "ok",
    error: null,
    time: nsPerCall(median),
    memory: null,
    measurements: [first, ...rest],
  };
}

/** The repetitions from `first` to `last`, both included. */
function span(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** A pattern matching contender `key`'s id followed by each of `repetitions`, in order. */
function naming(key: string, repetitions: readonly number[]): RegExp {
  return new RegExp(
    [
      `concat/${key}`,
      ...repetitions.map((repetition) => String.raw`\b${String(repetition)}\b`),
    ].join("[^/]*"),
    "u",
  );
}

/** Contender `key`, measured in repetition 1 for its memory alone, `bytes` per call. */
function memoryOnly(key: string, bytes: number): MeasuredResult {
  return {
    ...base(key),
    status: "ok",
    error: null,
    time: null,
    memory: bytesPerCall(bytes),
    measurements: [{ repetition: 1, orderInRepetition: 1, time: null, memory: memoryOf(bytes) }],
  };
}

/** Contender `key`, timed at `medians` in the repetitions before the one it failed in. */
function failed(key: string, medians: readonly number[]): FailedResult {
  return {
    ...base(key),
    status: "failed",
    error: { phase: "fn", message: "kiwi", stack: null, teardownError: null, output: "" },
    time: null,
    memory: null,
    measurements: [
      ...medians.map((median, index) => timedIn(index + 1, median)),
      { repetition: medians.length + 1, orderInRepetition: 1, time: null, memory: null },
    ],
  };
}

/** The contest of one timed contender per key of `byKey`, in key order. */
function judgedOf(
  byKey: Readonly<Record<string, readonly Timing[]>>,
): ReturnType<typeof contestOf> {
  const [first, ...rest] = Object.entries(byKey).map(([key, timings]) => timed(key, timings));
  if (first === undefined) throw new RangeError("a contest needs one contender");
  return contestOf([first, ...rest]);
}

/** The per-repetition `ln(b / a)` of two contenders' per-repetition medians. */
function logRatios(a: readonly number[], b: readonly number[]): number[] {
  return a.map((median, repetition) => Math.log((b[repetition] ?? Number.NaN) / median));
}

/** A matcher for a number equal to `value` up to rounding. */
function near(value: number): unknown {
  return expect.closeTo(value, 10);
}

/** The exact interval of `differences` at `level`, as ratios, each end matched up to rounding. */
function ratioInterval(differences: readonly number[], level: number): unknown[] {
  return signedRankInterval(differences, level).map((end) => near(Math.exp(end)));
}

/** `pairs` sorted by their first contender, then their second. */
function byContenders<T extends Pick<ContestPair, "a" | "b">>(pairs: readonly T[]): T[] {
  return pairs.toSorted((left, right) =>
    `${left.a} ${left.b}`.localeCompare(`${right.a} ${right.b}`),
  );
}

/** Per-repetition medians where `plus` is proven faster than `join` and `loop` is told apart from neither. */
const TIED = {
  join: repeated(200, 8),
  loop: [50, 250, 50, 250, 50, 250, 50, 250],
  plus: repeated(100, 8),
};

/** Per-repetition medians of a three-contender contest whose three pairs are each proven. */
const THREE_PROVEN = {
  plus: repeated(100, 8),
  loop: [95, 160, 140, 155, 145, 150, 165, 135],
  join: [190, 200, 210, 220, 195, 205, 215, 230],
};

/** The pairs of `THREE_PROVEN`, the faster contender first. */
const THREE_PROVEN_PAIRS = [
  ["plus", "loop"],
  ["plus", "join"],
  ["loop", "join"],
] as const;

const THREE_PROVEN_DIFFERENCES = THREE_PROVEN_PAIRS.map(([a, b]) =>
  logRatios(THREE_PROVEN[a], THREE_PROVEN[b]),
);

describe("contestOf", () => {
  describe("when a contender is told apart from neither of a proven pair", () => {
    it("ranks each contender 1 plus the contenders proven faster than it", () => {
      const contest = judgedOf(TIED);

      expect(
        Object.fromEntries(contest.contenders.map(({ id, rank }) => [id, rank])),
      ).toStrictEqual({ "concat/plus": 1, "concat/loop": 1, "concat/join": 2 });
    });

    it("sorts contenders of equal rank by median", () => {
      const contest = judgedOf(TIED);

      expect(contest.contenders.map(({ id, time }) => [id, time?.median])).toStrictEqual([
        ["concat/plus", 100],
        ["concat/loop", 150],
        ["concat/join", 200],
      ]);
    });

    it("gives each contender its ratio to the first", () => {
      const contest = judgedOf(TIED);

      expect(
        Object.fromEntries(contest.contenders.map(({ id, ratio }) => [id, ratio])),
      ).toStrictEqual({
        "concat/plus": 1,
        "concat/loop": near(Math.exp(hodgesLehmann(logRatios(TIED.plus, TIED.loop)))),
        "concat/join": near(Math.exp(hodgesLehmann(logRatios(TIED.plus, TIED.join)))),
      });
    });

    it("names no faster contender for the pairs it is in", () => {
      const contest = judgedOf(TIED);

      expect(
        byContenders(contest.pairs).map((pair) => [pair.a, pair.b, pair.faster]),
      ).toStrictEqual([
        ["concat/loop", "concat/join", null],
        ["concat/plus", "concat/join", "concat/plus"],
        ["concat/plus", "concat/loop", null],
      ]);
    });
  });

  it("lists pairs by their first contender's place in the ranking, then their second's", () => {
    // Emitted slowest first; eight repetitions prove all six pairs, ranking a, b, c, d.
    const contest = judgedOf({
      d: repeated(400, 8),
      c: repeated(300, 8),
      b: repeated(200, 8),
      a: repeated(100, 8),
    });

    expect(contest.pairs.map((pair) => [pair.a, pair.b])).toStrictEqual([
      ["concat/a", "concat/b"],
      ["concat/a", "concat/c"],
      ["concat/a", "concat/d"],
      ["concat/b", "concat/c"],
      ["concat/b", "concat/d"],
      ["concat/c", "concat/d"],
    ]);
  });

  it("sorts a contender proven faster ahead of one with a lower median", () => {
    const callsPerSample = 1_000_000;
    const at = (median: number): Timing => ({ median, callsPerSample });

    const contest = judgedOf({
      x: [11, 11, 11, 11, 110, 110, 110, 95].map(at),
      y: [10, 10, 10, 10, 100, 100, 100, 100].map(at),
    });

    expect(contest.contenders.map(({ id, time, rank }) => ({ id, time, rank }))).toStrictEqual([
      { id: "concat/y", time: nsPerCall(55), rank: 1 },
      { id: "concat/x", time: nsPerCall(53), rank: 2 },
    ]);
  });

  it("adjusts each pair's p by Holm's over the contest's pairs", () => {
    const pValues = THREE_PROVEN_DIFFERENCES.map((differences) => signedRankP(differences));
    const adjusted = holm(pValues);

    const contest = judgedOf(THREE_PROVEN);

    expect(
      byContenders(contest.pairs).map(({ a, b, p, pAdjusted }) => ({ a, b, p, pAdjusted })),
    ).toStrictEqual(
      byContenders(
        THREE_PROVEN_PAIRS.map(([a, b], index) => ({
          a: `concat/${a}`,
          b: `concat/${b}`,
          p: near(pValues[index] ?? Number.NaN),
          pAdjusted: near(adjusted[index] ?? Number.NaN),
        })),
      ),
    );
  });

  it("widens each pair's interval to 1 − 0.05 / pairs", () => {
    const contest = judgedOf(THREE_PROVEN);

    expect(
      byContenders(contest.pairs).map(({ a, b, interval }) => ({ a, b, interval })),
    ).toStrictEqual(
      byContenders(
        THREE_PROVEN_PAIRS.map(([a, b], index) => ({
          a: `concat/${a}`,
          b: `concat/${b}`,
          interval: ratioInterval(THREE_PROVEN_DIFFERENCES[index] ?? [], 1 - 0.05 / 3),
        })),
      ),
    );
  });

  it.each([
    {
      why: "whose repetitions do not reach the significance bar",
      loop: [500, 2000, 500, 2000, 500, 2000, 500],
      faster: null,
      tie: "repetitions",
    },
    {
      why: "proven within 1.25 resolutions per call of 1, as a share of the smaller median",
      loop: repeated<Timing>(1026, 7),
      faster: null,
      tie: "timer",
    },
    {
      why: "proven beyond it",
      loop: repeated<Timing>(1030, 7),
      faster: "concat/join",
      tie: null,
    },
    {
      why: "proven beyond it the other way",
      loop: repeated<Timing>(970, 7),
      faster: "concat/loop",
      tie: null,
    },
    {
      why: "proven within the resolution per call of the pair's coarsest process",
      loop: [1030, 1030, { median: 1030, callsPerSample: 1 }, 1030, 1030, 1030, 1030],
      faster: null,
      tie: "timer",
    },
  ])("names $faster faster and $tie as the tie for a ratio $why", ({ loop, faster, tie }) => {
    const contest = judgedOf({ join: repeated(1000, 7), loop });

    expect(contest.pairs.map((pair) => ({ faster: pair.faster, tie: pair.tie }))).toStrictEqual([
      { faster, tie },
    ]);
  });

  it("ties pairs whose p clears the bar only before the Holm adjustment", () => {
    const contest = judgedOf({
      join: repeated(1000, 7),
      loop: [...repeated(1500, 6), 990],
      plus: [...repeated(2250, 6), 980],
    });

    expect(
      byContenders(contest.pairs).map(({ p, faster, tie }) => ({
        clearsTheBar: p <= 0.05,
        faster,
        tie,
      })),
    ).toStrictEqual(repeated({ clearsTheBar: true, faster: null, tie: "repetitions" }, 3));
  });

  describe("when the repetitions cannot reach a verdict", () => {
    it("holds the medians, sorted, with no rank, ratio or pair", () => {
      const contest = judgedOf({ join: repeated(300, 5), loop: repeated(100, 5) });

      expect(contest).toStrictEqual({
        name: "concat",
        params: {},
        runtime: runtimeOf("node"),
        repetitionCount: 5,
        contenders: [
          { id: "concat/loop", time: nsPerCall(100), memory: null, ratio: null, rank: null },
          { id: "concat/join", time: nsPerCall(300), memory: null, ratio: null, rank: null },
        ],
        pairs: [],
      });
    });

    it.each([
      { contenders: 3, repetitions: 6, judged: false },
      { contenders: 3, repetitions: 7, judged: true },
    ])(
      "judges $contenders contenders over $repetitions repetitions: $judged",
      ({ contenders, repetitions, judged }) => {
        const byKey = Object.fromEntries(
          Array.from({ length: contenders }, (_, index) => [
            `c${String(index)}`,
            repeated(100 * (index + 1), repetitions),
          ]),
        );

        const contest = judgedOf(byKey);

        expect(contest.pairs).toHaveLength(judged ? (contenders * (contenders - 1)) / 2 : 0);
      },
    );
  });

  describe("when timed contenders ran different repetitions", () => {
    it.each([
      { why: "the first ran one the second did not", join: span(1, 8), loop: span(1, 7) },
      { why: "the second ran one the first did not", join: span(1, 7), loop: span(1, 8) },
      { why: "the first ran two the second did not", join: span(1, 9), loop: span(1, 7) },
    ])(
      "throws a RangeError naming each and the repetitions only it ran when $why",
      ({ join, loop }) => {
        const joinOnly = join.filter((repetition) => !loop.includes(repetition));
        const loopOnly = loop.filter((repetition) => !join.includes(repetition));

        const error = errorOf(() =>
          contestOf([timedOver("join", join, 100), timedOver("loop", loop, 200)]),
        );

        expect(error).toBeInstanceOf(RangeError);
        expect(error).toHaveProperty("message", expect.stringMatching(naming("join", joinOnly)));
        expect(error).toHaveProperty("message", expect.stringMatching(naming("loop", loopOnly)));
      },
    );

    it.each([
      { none: "loop", join: span(1, 8), loop: span(1, 7) },
      { none: "join", join: span(1, 7), loop: span(1, 8) },
    ])(
      "names none for $none, which ran no repetition the other did not",
      ({ none, join, loop }) => {
        const error = errorOf(() =>
          contestOf([timedOver("join", join, 100), timedOver("loop", loop, 200)]),
        );

        expect(error.message).toMatch(new RegExp(String.raw`concat/${none}[^/]*\bnone\b`, "u"));
      },
    );

    it("returns the contest not judged when too few repetitions ran", () => {
      const contest = contestOf([
        timedOver("join", span(1, 5), 300),
        timedOver("loop", span(1, 4), 100),
      ]);

      expect(contest).toStrictEqual({
        name: "concat",
        params: {},
        runtime: runtimeOf("node"),
        repetitionCount: 5,
        contenders: [
          { id: "concat/loop", time: nsPerCall(100), memory: null, ratio: null, rank: null },
          { id: "concat/join", time: nsPerCall(300), memory: null, ratio: null, rank: null },
        ],
        pairs: [],
      });
    });
  });

  describe("when the contenders were not timed", () => {
    it("keeps them in results order with their memory and no time, ratio, rank or pair", () => {
      const contest = contestOf([memoryOnly("loop", 40), memoryOnly("join", 80)]);

      expect(contest).toStrictEqual({
        name: "concat",
        params: {},
        runtime: runtimeOf("node"),
        repetitionCount: 1,
        contenders: [
          { id: "concat/loop", time: null, memory: bytesPerCall(40), ratio: null, rank: null },
          { id: "concat/join", time: null, memory: bytesPerCall(80), ratio: null, rank: null },
        ],
        pairs: [],
      });
    });
  });

  describe("when a contender fails", () => {
    it("judges the rest among themselves, listing it last with no median, rank or ratio", () => {
      const join = [100, 102, 98, 101, 99, 100];
      const plus = [200, 210, 190, 205, 195, 220];
      const differences = logRatios(join, plus);
      const ratio = near(Math.exp(hodgesLehmann(differences)));
      const p = signedRankP(differences);

      const contest = contestOf([timed("join", join), failed("loop", [17]), timed("plus", plus)]);

      expect(contest).toStrictEqual({
        name: "concat",
        params: {},
        runtime: runtimeOf("node"),
        repetitionCount: 6,
        contenders: [
          { id: "concat/join", time: nsPerCall(100), memory: null, ratio: 1, rank: 1 },
          { id: "concat/plus", time: nsPerCall(202.5), memory: null, ratio, rank: 2 },
          { id: "concat/loop", time: null, memory: null, ratio: null, rank: null },
        ],
        pairs: [
          {
            a: "concat/join",
            b: "concat/plus",
            ratio,
            interval: ratioInterval(differences, 0.95),
            p: near(p),
            pAdjusted: near(holm([p])[0] ?? Number.NaN),
            faster: "concat/join",
            tie: null,
          },
        ],
      });
    });

    it("leaves the contest not judged when fewer than two never failed, the failed ones in results order", () => {
      const contest = contestOf([
        failed("loop", []),
        failed("join", [100]),
        timed("plus", repeated(200, 8)),
      ]);

      expect(contest.contenders.map(({ id, ratio, rank }) => ({ id, ratio, rank }))).toStrictEqual([
        { id: "concat/plus", ratio: null, rank: null },
        { id: "concat/loop", ratio: null, rank: null },
        { id: "concat/join", ratio: null, rank: null },
      ]);
    });
  });
});

describe("signedRankInterval", () => {
  it("throws a RangeError naming the level and the count when too few differences reach it", () => {
    const error = errorOf(() => signedRankInterval([0.1, 0.2], 0.95));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(wordsInOrder(0.95, 2));
  });
});
