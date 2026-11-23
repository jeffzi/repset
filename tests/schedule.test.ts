import { describe, expect, it } from "vitest";

import type { MeasureRequest } from "../src/child-protocol.js";
import type { Outcome } from "../src/children.js";
import { type OnceInput, startEach } from "../src/schedule.js";
import {
  APPLE,
  BANANA,
  type CaseToList,
  contender,
  failsLoopInRepetitionTwo,
  findAny,
  listingStarter,
  measuredOutcome,
} from "./fake-children.js";
import { DISCOVERY, JOIN, LOOP, PLUS, SEED } from "./run-here.js";

/** One child `startEach` started: its runtime, case id, repetition and order in it. */
interface Started {
  readonly runtime: string;
  readonly id: string;
  readonly repetition: number | null;
  readonly order: number | null;
}

/** What `startEach` reported while starting the children of `cases`. */
interface Schedule {
  /** The children it planned once the selection passed, repetitions included. */
  readonly total: number;
  /** The number of contests that formed. */
  readonly contests: number;
  readonly started: Started[];
  readonly dropped: number[];
}

/** What a test changes about a schedule: the caller's options, the seed, and each child's answer. */
interface Plan {
  readonly input?: Partial<OnceInput>;
  readonly seed?: number;
  readonly answer?: (request: MeasureRequest) => Outcome;
}

/** Starts the children of `cases`, all listed in one file, seeded with {@link SEED} unless `plan` says. */
async function schedule(
  cases: readonly CaseToList[],
  { input = {}, seed = SEED, answer = () => measuredOutcome(4656) }: Plan = {},
): Promise<Schedule> {
  let total = 0;
  let contests = 0;
  const started: Started[] = [];
  const dropped: number[] = [];
  await startEach<MeasureRequest>(
    {
      cwd: DISCOVERY,
      files: ["zeta.bench.ts"],
      findRuntime: findAny,
      startChild: listingStarter([...cases], (request) => {
        if (request.mode !== "measure") throw new Error(`a ${request.mode} child started`);
        return answer(request);
      }),
      ...input,
    },
    (_options, selected) => ({
      mode: "measure",
      file: selected.path,
      id: selected.id,
      minTime: 0,
      minSamples: 1,
      time: true,
      memory: false,
    }),
    {
      passed: (_options, planned, formed) => {
        total = planned;
        contests = formed.length;
      },
      finished: ({ runtime, selected, repetition, orderInRepetition }) => {
        started.push({
          runtime: runtime.runtime,
          id: selected.id,
          repetition,
          order: orderInRepetition,
        });
      },
      dropped: (count) => {
        dropped.push(count);
      },
    },
    seed,
  );
  return { total, contests, started, dropped };
}

/** The ids of `started`, in start order. */
function idsOf(started: readonly Started[]): string[] {
  return started.map((child) => child.id);
}

/** How many children of case `id` `started` holds. */
function startsOf(started: readonly Started[], id: string): number {
  return started.filter((child) => child.id === id).length;
}

/** `items` cut into consecutive slices of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

describe("startEach", () => {
  describe("when a contest forms", () => {
    it("plans every repetition of each contest among the children of every runtime", async () => {
      const { total } = await schedule([APPLE, JOIN, LOOP], {
        input: { runtimes: ["node", "bun"] },
      });

      expect(total).toBe(30);
    });

    it("runs all of a contest's repetitions at its first contender's place, one child per contender back to back, on each runtime", async () => {
      const { started } = await schedule([APPLE, JOIN, BANANA, LOOP], {
        input: { runtimes: ["bun", "node"], contestRepetitionCount: 2 },
      });

      const ids = idsOf(started);
      const onRuntime = (offset: number): unknown[] => {
        const run = ids.slice(offset, offset + 6);
        return [run[0], run.slice(1, 3).toSorted(), run.slice(3, 5).toSorted(), run[5]];
      };
      const contest = ["concat/join", "concat/loop"];
      expect([onRuntime(0), onRuntime(6)]).toStrictEqual([
        ["apple", contest, contest, "banana"],
        ["apple", contest, contest, "banana"],
      ]);
    });

    it("runs 12 repetitions for 8 contenders when contestRepetitionCount is not given", async () => {
      const cases = Array.from({ length: 8 }, (_, index) => contender(`c${String(index)}`));

      const { started } = await schedule(cases);

      expect(cases.map(({ id }) => startsOf(started, id))).toStrictEqual(Array<number>(8).fill(12));
    });
  });

  describe("when one contender of a benchmark is selected", () => {
    it("runs it once as a plain case with no repetition, forming no contest", async () => {
      const { started, contests } = await schedule([APPLE, JOIN, LOOP], {
        input: { filter: "apple|join" },
      });

      expect({ started, contests }).toStrictEqual({
        started: [
          { runtime: "node", id: "apple", repetition: null, order: null },
          { runtime: "node", id: "concat/join", repetition: null, order: null },
        ],
        contests: 0,
      });
    });
  });

  describe("when the repetition orders are drawn", () => {
    it("repeats the orders for the same seed", async () => {
      const first = await schedule([JOIN, LOOP, PLUS]);

      const second = await schedule([JOIN, LOOP, PLUS]);

      expect(idsOf(second.started)).toStrictEqual(idsOf(first.started));
    });

    it("draws the orders uniformly from the permutations of the contenders", async () => {
      const ids: string[] = [];

      for (let seed = 1; seed <= 1000; seed += 1) {
        const seeded = await schedule([JOIN, LOOP, PLUS], {
          input: { contestRepetitionCount: 6 },
          seed,
        });
        ids.push(...idsOf(seeded.started));
      }

      const counts = Object.values(Object.groupBy(chunks(ids, 3), (order) => order.join(" ")));
      expect(counts.map((orders) => Math.abs((orders?.length ?? 0) - 1000) < 150)).toStrictEqual(
        Array<boolean>(6).fill(true),
      );
    });
  });

  describe("when a contender's child fails", () => {
    /** Schedules `concat` over 4 repetitions with `concat/loop` failing in repetition 2. */
    async function loopFailingInRepetitionTwo(): Promise<Schedule> {
      return schedule([JOIN, LOOP, PLUS], {
        input: { contestRepetitionCount: 4 },
        answer: failsLoopInRepetitionTwo(),
      });
    }

    it("runs it in no later repetition while the rest run every repetition", async () => {
      const { started } = await loopFailingInRepetitionTwo();

      expect({
        join: startsOf(started, "concat/join"),
        loop: startsOf(started, "concat/loop"),
        plus: startsOf(started, "concat/plus"),
      }).toStrictEqual({ join: 4, loop: 2, plus: 4 });
    });

    it("reports its repetitions still to come as dropped, once, so planned minus dropped is the children started", async () => {
      const { total, dropped, started } = await loopFailingInRepetitionTwo();

      const left = total - dropped.reduce((sum, count) => sum + count, 0);
      expect({ dropped, left }).toStrictEqual({ dropped: [2], left: started.length });
    });
  });
});
