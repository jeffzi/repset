import { describe, expect, it } from "vitest";

import type { FoundRuntime, Outcome } from "../src/children.js";
import type { ContestPair, Report, Result } from "../src/report.js";
import { hodgesLehmann, holm, signedRankInterval, signedRankP } from "../src/signed-rank.js";
import {
  APPLE,
  type Asked,
  BANANA,
  type CaseToList,
  contender,
  failedOutcome,
  failsLoopInRoundTwo,
  found,
  listingStarter,
  measured,
  measuredOutcome,
  stopped,
} from "./fake-children.js";
import { type RunInput, runHere } from "./run-here.js";

const JOIN = contender("join");
const LOOP = contender("loop");
const PLUS = contender("plus");

/** The seed `runCases` draws unless told otherwise. */
const SEED = 20_261_119;

/** Answers a measuring child; `index` counts the measuring children started before it. */
type Answer = (request: Asked, runtime: FoundRuntime, index: number) => Outcome;

/** Runs `cases`, all listed in one file, drawing `SEED`, and logs each measuring child's case id. */
async function runCases(
  cases: CaseToList[],
  input: Partial<RunInput> = {},
  answer: Answer = () => measuredOutcome(4656),
): Promise<{ report: Report; started: string[] }> {
  const started: string[] = [];
  const report = await runHere({
    drawSeed: () => SEED,
    startChild: listingStarter(cases, (request, runtime) => {
      started.push(request.id);
      return answer(request, runtime, started.length - 1);
    }),
    ...input,
  });
  return { report, started };
}

/** `items` cut into consecutive slices of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

/** Each process of `result` as its round, its order in the round and its median. */
function processesOf(result: Result): (number | null)[][] {
  return result.processes.map((process) => [
    process.round,
    process.orderInRound,
    process.stats?.median ?? null,
  ]);
}

/** What a contender's child answers in one round: its median, a whole outcome, or `null` to fail. */
type Answered = number | Outcome | null;

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

/** A counter of the calls made per id: each call returns the zero-based count before it. */
function callCounter(): (id: string) => number {
  const calls = new Map<string, number>();
  return (id) => {
    const call = calls.get(id) ?? 0;
    calls.set(id, call + 1);
    return call;
  };
}

/** The pairs of the first contest of `report`, sorted by their contenders. */
function sortedPairs(report: Report): ContestPair[] {
  return byContenders(report.contests[0]?.pairs ?? []);
}

/** How many of `items` equal `item`. */
function countOf(items: readonly string[], item: string): number {
  return items.filter((candidate) => candidate === item).length;
}

/** Runs the contest `concat`, its contenders listed in key order, each child answered by round. */
async function judge(
  byRound: Readonly<Record<string, readonly Answered[]>>,
  input: Partial<RunInput> = {},
  cases: readonly CaseToList[] = Object.keys(byRound).map((key) => contender(key)),
): Promise<Report> {
  const nextCall = callCounter();
  const { report } = await runCases([...cases], input, (request) => {
    const call = nextCall(request.id);
    const scheduled = byRound[request.id.slice("concat/".length)]?.[call];
    const answered = scheduled === undefined ? 4656 : scheduled;
    if (answered === null) return failedOutcome("fn", "kiwi");
    return typeof answered === "number" ? measuredOutcome(answered) : answered;
  });
  return report;
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

/** `pairs` sorted by their first contender, then their second. */
function byContenders<T extends Pick<ContestPair, "a" | "b">>(pairs: readonly T[]): T[] {
  return pairs.toSorted((left, right) =>
    `${left.a} ${left.b}`.localeCompare(`${right.a} ${right.b}`),
  );
}

const NODE = { name: "node", version: found("node").version };

/** Per-round medians where `plus` is proven faster than `join` and `loop` is told apart from neither. */
const TIED = {
  join: repeated(200, 8),
  loop: [50, 250, 50, 250, 50, 250, 50, 250],
  plus: repeated(100, 8),
};

/** Per-round medians of a three-contender contest whose three pairs are each proven. */
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

describe("run", () => {
  describe("when a contest runs", () => {
    it("reports to onPlanned every round of each contest among the measuring children", async () => {
      const planned: number[] = [];

      await runCases([APPLE, JOIN, LOOP], {
        runtimes: ["node", "bun"],
        onPlanned: (total) => {
          planned.push(total);
        },
      });

      expect(planned.at(-1)).toBe(30);
    });

    it("runs all of a contest's rounds at its first contender's place, one child per contender back to back, on each runtime", async () => {
      const runtimes: string[] = [];

      const { started } = await runCases(
        [APPLE, JOIN, BANANA, LOOP],
        { runtimes: ["bun", "node"], rounds: 2 },
        (_request, runtime) => {
          runtimes.push(runtime.runtime);
          return measuredOutcome(4656);
        },
      );

      const onRuntime = (offset: number): unknown[] => {
        const ids = started.slice(offset, offset + 6);
        return [ids[0], ids.slice(1, 3).toSorted(), ids.slice(3, 5).toSorted(), ids[5]];
      };
      const contest = ["concat/join", "concat/loop"];
      expect({ runtimes, started: [onRuntime(0), onRuntime(6)] }).toStrictEqual({
        runtimes: [...Array<string>(6).fill("bun"), ...Array<string>(6).fill("node")],
        started: [
          ["apple", contest, contest, "banana"],
          ["apple", contest, contest, "banana"],
        ],
      });
    });

    it("runs a lone selected contender once, keeping its contender key, as a plain case", async () => {
      const { report } = await runCases([APPLE, JOIN, LOOP], { filter: "apple|join" });

      expect(
        report.results.map((result) => [
          result.id,
          result.name,
          result.contender,
          processesOf(result),
        ]),
      ).toStrictEqual([
        ["apple", "apple", null, [[1, 1, 4656]]],
        ["concat/join", "concat", "join", [[1, 1, 4656]]],
      ]);
    });

    it("runs 12 rounds for 8 contenders when rounds is not given", async () => {
      const cases = Array.from({ length: 8 }, (_, index) => contender(`c${String(index)}`));

      const { report } = await runCases(cases);

      expect(report.results.map((result) => result.processes.length)).toStrictEqual(
        Array<number>(8).fill(12),
      );
    });

    it.each([
      { rounds: 3, medians: { "concat/join": 40, "concat/loop": 30 } },
      { rounds: 4, medians: { "concat/join": 30, "concat/loop": 45 } },
    ])(
      "gives each contender one process per round in run order, its median the median of theirs, over $rounds rounds",
      async ({ rounds, medians }) => {
        const byRound: Record<string, number[]> = {
          "concat/join": [50, 10, 40, 20],
          "concat/loop": [30, 60, 5, 70],
        };
        const nextCall = callCounter();
        const answer: Answer = (request) => {
          const call = nextCall(request.id);
          return measuredOutcome(byRound[request.id]?.[call] ?? 0);
        };

        const { report, started } = await runCases([JOIN, LOOP], { rounds }, answer);

        const expectedOf = (id: "concat/join" | "concat/loop"): unknown[] => {
          const orders = started.flatMap((startedId, index) =>
            startedId === id ? [(index % 2) + 1] : [],
          );
          const processes = orders.map((order, round) => [round + 1, order, byRound[id]?.[round]]);
          return [id, "concat", id.slice("concat/".length), medians[id], processes];
        };
        expect(
          report.results
            .toSorted((left, right) => left.id.localeCompare(right.id))
            .map((result) => [
              result.id,
              result.name,
              result.contender,
              result.median,
              processesOf(result),
            ]),
        ).toStrictEqual([expectedOf("concat/join"), expectedOf("concat/loop")]);
      },
    );

    describe("when the round orders are drawn", () => {
      it("records the seed drawn when the run starts", async () => {
        const { report } = await runCases([JOIN, LOOP], { drawSeed: () => 1234 });

        expect(report.options.seed).toBe(1234);
      });

      it("records a null seed when no contest forms", async () => {
        const { report } = await runCases([APPLE, JOIN, LOOP], { filter: "apple|join" });

        expect(report.options.seed).toBeNull();
      });

      it("repeats the orders for the same seed", async () => {
        const { started: first } = await runCases([JOIN, LOOP, PLUS]);

        const { started: second } = await runCases([JOIN, LOOP, PLUS]);

        expect(second).toStrictEqual(first);
      });

      it("changes the orders with the seed", async () => {
        const { started: first } = await runCases([JOIN, LOOP, PLUS]);

        const { started: second } = await runCases([JOIN, LOOP, PLUS], {
          drawSeed: () => SEED + 1,
        });

        expect(second).not.toStrictEqual(first);
      });

      it("draws the orders uniformly from the permutations of the contenders", async () => {
        const started: string[] = [];

        for (let seed = 1; seed <= 1000; seed += 1) {
          const seeded = await runCases([JOIN, LOOP, PLUS], { rounds: 6, drawSeed: () => seed });
          started.push(...seeded.started);
        }

        const counts = Object.values(
          Object.groupBy(chunks(started, 3), (order) => order.join(" ")),
        );
        expect(counts.map((orders) => Math.abs((orders?.length ?? 0) - 1000) < 150)).toStrictEqual(
          Array<boolean>(6).fill(true),
        );
      });
    });

    describe("when a contender's child fails", () => {
      /** Runs `concat` over 4 rounds with `concat/loop` failing in round 2, logging starts and results. */
      async function runWithLoopFailingInRoundTwo(input: Partial<RunInput> = {}): Promise<{
        report: Report;
        started: string[];
        events: string[];
      }> {
        const events: string[] = [];
        const answer = failsLoopInRoundTwo();
        const { report, started } = await runCases(
          [JOIN, LOOP, PLUS],
          {
            ...input,
            rounds: 4,
            onResult: (result) => {
              events.push(`result ${result.id}`);
            },
          },
          (request) => {
            events.push(`start ${request.id}`);
            return answer(request);
          },
        );
        return { report, started, events };
      }

      it("gives it a failed result holding the processes that ran, the failed one last", async () => {
        const { report, started } = await runWithLoopFailingInRoundTwo();

        const orders = started.flatMap((id, index) =>
          id === "concat/loop" ? [(index % 3) + 1] : [],
        );
        const loop = report.results.find((result) => result.id === "concat/loop");
        expect({
          status: loop?.status,
          error: loop?.error?.message,
          median: loop?.median,
          processes: loop === undefined ? [] : processesOf(loop),
        }).toStrictEqual({
          status: "failed",
          error: "kiwi",
          median: null,
          processes: [
            [1, orders[0], 17],
            [2, orders[1], null],
          ],
        });
      });

      it("emits its result before the next child starts", async () => {
        const { events } = await runWithLoopFailingInRoundTwo();

        const failedAt = events.lastIndexOf("start concat/loop");
        expect(events[failedAt + 1]).toBe("result concat/loop");
      });

      it("runs it in no later round while the rest run every round", async () => {
        const { started } = await runWithLoopFailingInRoundTwo();

        expect({
          join: countOf(started, "concat/join"),
          loop: countOf(started, "concat/loop"),
          plus: countOf(started, "concat/plus"),
        }).toStrictEqual({ join: 4, loop: 2, plus: 4 });
      });

      it("gives every contender exactly one result", async () => {
        const { events } = await runWithLoopFailingInRoundTwo();

        expect({
          join: countOf(events, "result concat/join"),
          loop: countOf(events, "result concat/loop"),
          plus: countOf(events, "result concat/plus"),
        }).toStrictEqual({ join: 1, loop: 1, plus: 1 });
      });

      it("reports its rounds still to come as dropped, once, so planned minus dropped is the children started", async () => {
        const planned: number[] = [];
        const dropped: number[] = [];

        const { started } = await runWithLoopFailingInRoundTwo({
          onPlanned: (total) => {
            planned.push(total);
          },
          onDropped: (count) => {
            dropped.push(count);
          },
        });

        const left = (planned.at(-1) ?? 0) - dropped.reduce((sum, count) => sum + count, 0);
        expect({ dropped, left }).toStrictEqual({ dropped: [2], left: started.length });
      });
    });

    it("emits each surviving contender's result when the contest's last round ends", async () => {
      const events: string[] = [];

      await runCases(
        [APPLE, JOIN, LOOP, BANANA],
        {
          rounds: 3,
          onResult: (result) => {
            events.push(`result ${result.id}`);
          },
        },
        (request) => {
          events.push(`start ${request.id}`);
          return measuredOutcome(4656);
        },
      );

      expect([
        events.slice(0, 2),
        events.slice(2, 8).map((event) => event.startsWith("start concat/")),
        events.slice(8, 10).toSorted(),
        events.slice(10),
      ]).toStrictEqual([
        ["start apple", "result apple"],
        Array<boolean>(6).fill(true),
        ["result concat/join", "result concat/loop"],
        ["start banana", "result banana"],
      ]);
    });

    describe("when the stop signal fires mid-contest", () => {
      it("keeps the results emitted before it and emits nothing more for the contest", async () => {
        const controller = new AbortController();
        let joinCalls = 0;

        const { report } = await runCases(
          [APPLE, JOIN, LOOP, PLUS],
          { rounds: 3, signal: controller.signal },
          (request) => {
            if (request.id === "concat/loop") return failedOutcome("fn", "kiwi");
            if (request.id === "concat/join") joinCalls += 1;
            if (joinCalls < 2) return measuredOutcome(4656);
            controller.abort();
            return stopped;
          },
        );

        expect({
          interrupted: report.interrupted,
          ids: report.results.map((result) => result.id),
        }).toStrictEqual({ interrupted: true, ids: ["apple", "concat/loop"] });
      });
    });
  });

  describe("when a contest is judged", () => {
    it("reports the contest judged from the contenders' per-round medians", async () => {
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
              tie: null,
            },
          ],
        },
      ]);
    });

    describe("when a contender is told apart from neither of a proven pair", () => {
      it("ranks each contender 1 plus the contenders proven faster than it", async () => {
        const report = await judge(TIED);

        const contenders = report.contests[0]?.contenders ?? [];
        expect(Object.fromEntries(contenders.map(({ id, rank }) => [id, rank]))).toStrictEqual({
          "concat/plus": 1,
          "concat/loop": 1,
          "concat/join": 2,
        });
      });

      it("sorts contenders of equal rank by median", async () => {
        const report = await judge(TIED);

        expect(report.contests[0]?.contenders.map(({ id, median }) => [id, median])).toStrictEqual([
          ["concat/plus", 100],
          ["concat/loop", 150],
          ["concat/join", 200],
        ]);
      });

      it("gives each contender its ratio to the first", async () => {
        const report = await judge(TIED);

        const contenders = report.contests[0]?.contenders ?? [];
        expect(Object.fromEntries(contenders.map(({ id, ratio }) => [id, ratio]))).toStrictEqual({
          "concat/plus": 1,
          "concat/loop": near(Math.sqrt(1.25)),
          "concat/join": near(2),
        });
      });

      it("names no faster contender for the pairs it is in", async () => {
        const report = await judge(TIED);

        expect(
          report.contests[0]?.pairs.map((pair) => [pair.a, pair.b, pair.faster]).toSorted(),
        ).toStrictEqual([
          ["concat/loop", "concat/join", null],
          ["concat/plus", "concat/join", "concat/plus"],
          ["concat/plus", "concat/loop", null],
        ]);
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

    it("adjusts each pair's p by Holm's over the contest's pairs", async () => {
      const pValues = THREE_PROVEN_DIFFERENCES.map((differences) => signedRankP(differences));
      const adjusted = holm(pValues);

      const report = await judge(THREE_PROVEN);

      expect(
        sortedPairs(report).map(({ a, b, p, pAdjusted }) => ({
          a,
          b,
          p,
          pAdjusted,
        })),
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

    it("widens each pair's interval to 1 − 0.05 / pairs", async () => {
      const report = await judge(THREE_PROVEN);

      expect(
        sortedPairs(report).map(({ a, b, interval }) => ({
          a,
          b,
          interval,
        })),
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
        why: "whose rounds do not reach the significance bar",
        loop: [500, 2000, 500, 2000, 500, 2000, 500],
        faster: null,
        tie: "rounds",
      },
      {
        why: "proven within 1.25 resolutions per call of 1, as a share of the smaller median",
        loop: repeated<Answered>(1026, 7),
        faster: null,
        tie: "timer",
      },
      {
        why: "proven beyond it",
        loop: repeated<Answered>(1030, 7),
        faster: "concat/join",
        tie: null,
      },
      {
        why: "proven beyond it the other way",
        loop: repeated<Answered>(970, 7),
        faster: "concat/loop",
        tie: null,
      },
      {
        why: "proven within the resolution per call of the pair's coarsest process",
        loop: [1030, 1030, measuredAt(1030, 1), 1030, 1030, 1030, 1030],
        faster: null,
        tie: "timer",
      },
    ])(
      "names $faster faster and $tie as the tie for a ratio $why",
      async ({ loop, faster, tie }) => {
        const report = await judge({ join: repeated(1000, 7), loop });

        expect(
          report.contests[0]?.pairs.map((pair) => ({ faster: pair.faster, tie: pair.tie })),
        ).toStrictEqual([{ faster, tie }]);
      },
    );

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

    it("ties pairs whose p clears the bar only before the Holm adjustment", async () => {
      const report = await judge({
        join: repeated(1000, 7),
        loop: [...repeated(1500, 6), 990],
        plus: [...repeated(2250, 6), 980],
      });

      expect(
        sortedPairs(report).map(({ p, faster, tie }) => ({
          p,
          faster,
          tie,
        })),
      ).toStrictEqual(repeated({ p: near(0.03125), faster: null, tie: "rounds" }, 3));
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
                tie: null,
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

    describe("when every contender fails", () => {
      it("is recorded before onResult receives the last failed result", async () => {
        const seen: string[][] = [];

        await judge(
          { join: [null], loop: [null] },
          {
            onResult: (_result, contests) => {
              seen.push(contests.map((entry) => entry.name));
            },
          },
        );

        expect(seen).toStrictEqual([[], ["concat"]]);
      });
    });

    it("is recorded once per contest and runtime, never for a plain case", async () => {
      const report = await judge({}, { runtimes: ["node", "bun"], rounds: 2 }, [APPLE, JOIN, LOOP]);

      expect(report.contests.map((entry) => [entry.name, entry.runtime.name])).toStrictEqual([
        ["concat", "node"],
        ["concat", "bun"],
      ]);
    });

    describe("when the stop signal fires mid-contest", () => {
      it("is dropped, keeping the entries of the contests that finished", async () => {
        const controller = new AbortController();
        const stopsOnBun = listingStarter([JOIN, LOOP], (_request, runtime) => {
          if (runtime.runtime === "node") return measuredOutcome(4656);
          controller.abort();
          return stopped;
        });

        const report = await judge(
          {},
          {
            runtimes: ["node", "bun"],
            rounds: 2,
            signal: controller.signal,
            startChild: stopsOnBun,
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
