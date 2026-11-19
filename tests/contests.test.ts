import { describe, expect, it } from "vitest";

import type { Outcome } from "../src/children.js";
import type { Report } from "../src/report.js";
import { run } from "../src/run.js";
import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "../src/signed-rank.js";
import {
  type CaseToList,
  failedOutcome,
  findAny,
  found,
  listingStarter,
  measured,
  measuredOutcome,
  stopped,
} from "./fake-children.js";
import { fixturePath } from "./fixture-path.js";

type RunInput = Parameters<typeof run>[0];

/** What a contender's child answers in one round: its median, a whole outcome, or `null` to fail. */
type Answered = number | Outcome | null;

/** The contender `key` of the contest `concat`. */
function contender(key: string): CaseToList {
  return { id: `concat/${key}`, setupPerCall: false, name: "concat", contender: key };
}

const APPLE: CaseToList = { id: "apple", setupPerCall: false };

/** An outcome measuring the median `median` at `callsPerSample` calls per sample. */
function measuredAt(median: number, callsPerSample: number): Outcome {
  const result = measured(median);
  return {
    status: "ok",
    result: { ...result, sampling: { ...result.sampling, callsPerSample } },
    output: "",
  };
}

/** `count` copies of `value`. */
function repeated<T>(value: T, count: number): T[] {
  return Array<T>(count).fill(value);
}

/** Runs the contest `concat`, its contenders listed in key order, each child answered by round. */
async function judge(
  byRound: Readonly<Record<string, readonly Answered[]>>,
  input: Partial<RunInput> = {},
  cases: readonly CaseToList[] = Object.keys(byRound).map((key) => contender(key)),
): Promise<Report> {
  const calls = new Map<string, number>();
  return run({
    cwd: fixturePath("discovery"),
    files: ["zeta.bench.ts"],
    findRuntime: findAny,
    packageJson: fixturePath("run", "version.json"),
    cpus: () => [],
    drawSeed: () => 20_261_119,
    startChild: listingStarter([...cases], (request) => {
      const call = calls.get(request.id) ?? 0;
      calls.set(request.id, call + 1);
      const scheduled = byRound[request.id.slice("concat/".length)]?.[call];
      const answered = scheduled === undefined ? 4656 : scheduled;
      if (answered === null) return failedOutcome("fn", "kiwi");
      return typeof answered === "number" ? measuredOutcome(answered) : answered;
    }),
    ...input,
  });
}

/** The per-round `ln(b / a)` of two contenders' per-round medians. */
function logRatios(a: readonly number[], b: readonly number[]): number[] {
  return a.map((median, round) => Math.log((b[round] ?? Number.NaN) / median));
}

/** A matcher for a number equal to `value` up to rounding. */
function near(value: number): unknown {
  return expect.closeTo(value, 10);
}

/** The exact interval of `differences` at `level`, as ratios, each end matched up to rounding. */
function ratioInterval(differences: readonly number[], level: number): unknown[] {
  return signedRankInterval(differences, level).map((end) => near(Math.exp(end)));
}

const NODE = { name: "node", version: found("node").version };

describe("run", () => {
  describe("a contest's entry", () => {
    it("holds each contender's median, ratio and rank and the pair's verdict, the faster first", async () => {
      const join = [800, 810, 812, 815, 820, 805, 812];
      const loop = [1850, 1880, 1904.5, 1920, 1890, 1910, 1904.5];
      const differences = logRatios(join, loop);
      const ratio = near(Math.exp(hodgesLehmann(differences)));

      const report = await judge({ loop, join });

      expect(report.contests).toStrictEqual([
        {
          name: "concat",
          params: {},
          runtime: NODE,
          rounds: 7,
          contenders: [
            { id: "concat/join", median: 812, ratio: 1, rank: 1 },
            { id: "concat/loop", median: 1904.5, ratio, rank: 2 },
          ],
          pairs: [
            {
              a: "concat/join",
              b: "concat/loop",
              ratio,
              interval: ratioInterval(differences, 0.95),
              p: near(0.015625),
              pAdjusted: near(0.015625),
              faster: "concat/join",
            },
          ],
        },
      ]);
    });

    it("ranks each contender 1 plus the contenders proven faster, sorted by rank then median, a tied one beside both", async () => {
      const report = await judge({
        join: repeated(200, 8),
        loop: [50, 250, 50, 250, 50, 250, 50, 250],
        plus: repeated(100, 8),
      });

      const [entry] = report.contests;
      expect({
        contenders: entry?.contenders,
        pairs: entry?.pairs.map((pair) => [pair.a, pair.b, pair.faster]).toSorted(),
      }).toStrictEqual({
        contenders: [
          { id: "concat/plus", median: 100, ratio: 1, rank: 1 },
          { id: "concat/loop", median: 150, ratio: near(Math.sqrt(1.25)), rank: 1 },
          { id: "concat/join", median: 200, ratio: near(2), rank: 2 },
        ],
        pairs: [
          ["concat/loop", "concat/join", null],
          ["concat/plus", "concat/join", "concat/plus"],
          ["concat/plus", "concat/loop", null],
        ],
      });
    });

    it("sorts a contender proven faster ahead of one with a lower median", async () => {
      const callsPerSample = 1_000_000;
      const y = [10, 10, 10, 10, 100, 100, 100, 100];
      const x = [11, 11, 11, 11, 110, 110, 110, 95];

      const report = await judge(
        {
          x: x.map((median) => measuredAt(median, callsPerSample)),
          y: y.map((median) => measuredAt(median, callsPerSample)),
        },
        { rounds: 8 },
      );

      expect(
        report.contests[0]?.contenders.map(({ id, median, rank }) => ({ id, median, rank })),
      ).toStrictEqual([
        { id: "concat/y", median: 55, rank: 1 },
        { id: "concat/x", median: 53, rank: 2 },
      ]);
    });

    it("adjusts each pair's p by Holm's over the contest's pairs and widens its interval to 1 − 0.05 / pairs", async () => {
      const medians = {
        plus: repeated(100, 8),
        loop: [95, 160, 140, 155, 145, 150, 165, 135],
        join: [190, 200, 210, 220, 195, 205, 215, 230],
      };
      const pairs = [
        ["plus", "loop"],
        ["plus", "join"],
        ["loop", "join"],
      ] as const;
      const differences = pairs.map(([a, b]) => logRatios(medians[a], medians[b]));
      const pValues = differences.map((pair) => signedRankP(pair));
      const adjusted = holm(pValues);

      const report = await judge(medians);

      expect(
        report.contests[0]?.pairs.toSorted((left, right) =>
          `${left.a} ${left.b}`.localeCompare(`${right.a} ${right.b}`),
        ),
      ).toStrictEqual(
        pairs
          .map(([a, b], index) => ({
            a: `concat/${a}`,
            b: `concat/${b}`,
            ratio: near(Math.exp(hodgesLehmann(differences[index] ?? []))),
            interval: ratioInterval(differences[index] ?? [], 1 - 0.05 / 3),
            p: near(pValues[index] ?? Number.NaN),
            pAdjusted: near(adjusted[index] ?? Number.NaN),
            faster: `concat/${a}`,
          }))
          .toSorted((left, right) => `${left.a} ${left.b}`.localeCompare(`${right.a} ${right.b}`)),
      );
    });

    it.each([
      {
        why: "within 1.25 resolutions per call of 1, as a share of the smaller median",
        loop: repeated<Answered>(1026, 7),
        faster: null,
      },
      { why: "beyond it", loop: repeated<Answered>(1030, 7), faster: "concat/join" },
      { why: "beyond it the other way", loop: repeated<Answered>(970, 7), faster: "concat/loop" },
      {
        why: "within the resolution per call of the pair's coarsest process",
        loop: [1030, 1030, measuredAt(1030, 1), 1030, 1030, 1030, 1030],
        faster: null,
      },
    ])("names $faster faster for a proven ratio $why", async ({ loop, faster }) => {
      const report = await judge({ join: repeated(1000, 7), loop });

      expect(report.contests[0]?.pairs.map((pair) => pair.faster)).toStrictEqual([faster]);
    });

    describe("when the rounds cannot reach a verdict", () => {
      it("holds the medians, sorted, with no rank, ratio or pair", async () => {
        const report = await judge(
          { join: repeated(300, 5), loop: repeated(100, 5) },
          { rounds: 5 },
        );

        expect(report.contests).toStrictEqual([
          {
            name: "concat",
            params: {},
            runtime: NODE,
            rounds: 5,
            contenders: [
              { id: "concat/loop", median: 100, ratio: null, rank: null },
              { id: "concat/join", median: 300, ratio: null, rank: null },
            ],
            pairs: [],
          },
        ]);
      });

      it.each([
        { contenders: 2, rounds: 5, judged: false },
        { contenders: 2, rounds: 6, judged: true },
        { contenders: 3, rounds: 6, judged: false },
        { contenders: 3, rounds: 7, judged: true },
      ])(
        "judges $contenders contenders over $rounds rounds: $judged",
        async ({ contenders, rounds, judged }) => {
          const byRound = Object.fromEntries(
            Array.from({ length: contenders }, (_, index) => [
              `c${String(index)}`,
              repeated(100 * (index + 1), rounds),
            ]),
          );

          const report = await judge(byRound, { rounds });

          expect(report.contests[0]?.pairs.length).toBe(
            judged ? (contenders * (contenders - 1)) / 2 : 0,
          );
        },
      );
    });

    describe("when a contender fails", () => {
      it("judges the rest among themselves, listing it last with no median, rank or ratio", async () => {
        const join = [100, 102, 98, 101, 99, 100];
        const plus = [200, 210, 190, 205, 195, 220];
        const differences = logRatios(join, plus);
        const ratio = near(Math.exp(hodgesLehmann(differences)));

        const report = await judge({ join, loop: [17, null], plus }, { rounds: 6 });

        expect(report.contests).toStrictEqual([
          {
            name: "concat",
            params: {},
            runtime: NODE,
            rounds: 6,
            contenders: [
              { id: "concat/join", median: 100, ratio: 1, rank: 1 },
              { id: "concat/plus", median: 202.5, ratio, rank: 2 },
              { id: "concat/loop", median: null, ratio: null, rank: null },
            ],
            pairs: [
              {
                a: "concat/join",
                b: "concat/plus",
                ratio,
                interval: ratioInterval(differences, 0.95),
                p: near(0.03125),
                pAdjusted: near(0.03125),
                faster: "concat/join",
              },
            ],
          },
        ]);
      });

      it("leaves the contest not judged when fewer than two never failed, the failed ones in results order", async () => {
        const report = await judge({ join: [100, null], loop: [null], plus: repeated(200, 8) });

        expect(report.contests).toStrictEqual([
          {
            name: "concat",
            params: {},
            runtime: NODE,
            rounds: 8,
            contenders: [
              { id: "concat/plus", median: 200, ratio: null, rank: null },
              { id: "concat/loop", median: null, ratio: null, rank: null },
              { id: "concat/join", median: null, ratio: null, rank: null },
            ],
            pairs: [],
          },
        ]);
      });
    });

    it("is recorded once per contest and runtime, never for a plain case", async () => {
      const report = await judge({}, { runtimes: ["node", "bun"], rounds: 2 }, [
        APPLE,
        contender("join"),
        contender("loop"),
      ]);

      expect(report.contests.map((entry) => [entry.name, entry.runtime.name])).toStrictEqual([
        ["concat", "node"],
        ["concat", "bun"],
      ]);
    });

    describe("when the stop signal fires mid-contest", () => {
      it("is dropped, keeping the entries of the contests that finished", async () => {
        const controller = new AbortController();
        const report = await judge(
          {},
          {
            runtimes: ["node", "bun"],
            rounds: 2,
            signal: controller.signal,
            startChild: listingStarter(
              [contender("join"), contender("loop")],
              (_request, runtime) => {
                if (runtime.runtime === "node") return measuredOutcome(4656);
                controller.abort();
                return stopped;
              },
            ),
          },
        );

        expect({
          interrupted: report.interrupted,
          runtimes: report.contests.map((entry) => entry.runtime.name),
        }).toStrictEqual({ interrupted: true, runtimes: ["node"] });
      });
    });
  });
});
