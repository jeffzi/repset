import { beforeEach, describe, expect, it, vi } from "vitest";

import { bench, registeredCases } from "../src/bench.js";
import { REGISTRY, resetRegistry } from "./registry.js";

/** Runs `act` and returns what it threw. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Returns the ids of the registered cases, in registration order. */
function registeredIds(): string[] {
  return registeredCases().map((registered) => registered.id);
}

/** Calls `bench` with arguments its signature rejects at compile time. */
function benchUnchecked(name: unknown, benchmark: unknown): void {
  Reflect.apply(bench, undefined, [name, benchmark]);
}

/** Makes a bad `bench` call and returns what it threw. */
function rejectionOf(name: unknown, benchmark: unknown): unknown {
  return thrownBy(() => {
    benchUnchecked(name, benchmark);
  });
}

/** Asserts `error` is a TypeError whose message holds every fragment. */
function expectTypeErrorHolding(error: unknown, fragments: string[]): void {
  expect(error).toBeInstanceOf(TypeError);
  for (const fragment of fragments) {
    expect(String(error)).toContain(fragment);
  }
}

const sync = (): number => 1;

async function asyncFunction(): Promise<number> {
  return 1;
}

async function* asyncGenerator(): AsyncGenerator<number> {
  yield 1;
}

function* generator(): Generator<number> {
  yield 1;
}

beforeEach(() => {
  resetRegistry();
});

describe("bench", () => {
  describe("when given a bare function", () => {
    it("registers a shared-state case of that function with no teardown", () => {
      const fn = (): number => 1;

      bench("sort", fn);

      expect(registeredCases()).toStrictEqual([
        { id: "sort", case: { kind: "sharedState", setup: expect.any(Function), fn } },
      ]);
    });
  });

  describe("when given a benchmark object", () => {
    it("registers its own setup, fn and teardown", () => {
      const setup = (): number[] => [3, 1, 2];
      const fn = (values: number[]): number[] => values.toSorted((left, right) => left - right);
      const teardown = (values: number[]): void => {
        values.length = 0;
      };

      bench("sort", { setup, fn, teardown });

      expect(registeredCases()).toStrictEqual([
        { id: "sort", case: { kind: "sharedState", setup, fn, teardown } },
      ]);
    });

    it.each([
      { setupPerCall: true, kind: "perCall" },
      { setupPerCall: false, kind: "sharedState" },
    ])("registers the lifecycle $kind for setupPerCall $setupPerCall", ({ setupPerCall, kind }) => {
      bench("sort", { fn: () => 1, setupPerCall });

      expect(registeredCases()[0]?.case.kind).toBe(kind);
    });

    it("registers the default setup when it has no setup", () => {
      bench("bare", () => 1);
      bench("object", { fn: () => 1 });

      const [bare, object] = registeredCases();

      expect(object?.case.setup()).toBe(bare?.case.setup());
    });

    it("registers what their absence registers for fields set to undefined", () => {
      const fn = (): number => 1;

      bench("object", { setup: undefined, fn, teardown: undefined, setupPerCall: undefined });

      expect(registeredCases()).toStrictEqual([
        {
          id: "object",
          case: { kind: "sharedState", setup: expect.any(Function), fn },
        },
      ]);
    });
  });

  describe("when a call is rejected", () => {
    it.each([
      { name: 42, benchmark: sync, why: "a bad name" },
      { name: "sort", benchmark: { fn: 42 }, why: "a bad benchmark" },
    ])("registers nothing for $why", ({ name, benchmark }) => {
      bench("before", () => 1);

      thrownBy(() => {
        benchUnchecked(name, benchmark);
      });

      expect(registeredIds()).toStrictEqual(["before"]);
    });
  });

  describe("when given a name that is not a string", () => {
    it("throws a TypeError holding the value", () => {
      const error = rejectionOf(42, sync);

      expectTypeErrorHolding(error, ["42"]);
    });
  });

  describe("when given a name that breaks the name rule", () => {
    it.each([
      { name: "", why: "empty" },
      { name: "/sort", why: "a leading /" },
      { name: "sort/", why: "a trailing /" },
      { name: "sort//fast", why: "a doubled /" },
      { name: "sort fast", why: "a space" },
      { name: "sort/café", why: "a letter outside ASCII" },
    ])("throws a TypeError holding the name when it has $why", ({ name }) => {
      const error = rejectionOf(name, sync);

      expectTypeErrorHolding(error, [name]);
    });
  });

  describe("when given a name of several segments that keeps the name rule", () => {
    it("registers the case under that name", () => {
      bench("sort/in-place_v1.2", sync);

      expect(registeredIds()).toStrictEqual(["sort/in-place_v1.2"]);
    });
  });

  describe("when given a second argument that is not a function or an object", () => {
    it.each([
      { benchmark: 42, why: "a number", fragments: ["sort", "42"] },
      { benchmark: "banana", why: "a string", fragments: ["sort", "banana"] },
      { benchmark: null, why: "null", fragments: ["sort", "null"] },
      { benchmark: [sync], why: "an array", fragments: ["sort", "an array"] },
    ])("throws a TypeError for $why", ({ benchmark, fragments }) => {
      const error = rejectionOf("sort", benchmark);

      expectTypeErrorHolding(error, fragments);
    });
  });

  describe("when given a benchmark object with a field repset does not know", () => {
    it("throws a TypeError holding the field", () => {
      const error = rejectionOf("sort", { fn: sync, banana: 1 });

      expectTypeErrorHolding(error, ["sort", "banana"]);
    });
  });

  describe("when given a benchmark object with a field of the wrong type", () => {
    it.each([
      { benchmark: { setup: sync }, why: "fn missing", field: "fn" },
      { benchmark: { fn: { run: sync } }, why: "fn a record of functions", field: "fn" },
      { benchmark: { fn: sync, setup: null }, why: "setup null", field: "setup" },
      { benchmark: { fn: sync, teardown: null }, why: "teardown null", field: "teardown" },
      {
        benchmark: { fn: sync, setupPerCall: null },
        why: "setupPerCall null",
        field: "setupPerCall",
      },
    ])("throws a TypeError holding the field for $why", ({ benchmark, field }) => {
      const error = rejectionOf("sort", benchmark);

      expectTypeErrorHolding(error, ["sort", field]);
    });
  });

  describe("when given an async function", () => {
    it.each([
      { benchmark: asyncFunction, why: "a bare async function", fragments: ["sort"] },
      { benchmark: asyncGenerator, why: "a bare async generator", fragments: ["sort"] },
      { benchmark: { fn: asyncFunction }, why: "an async fn", fragments: ["sort", "fn"] },
      {
        benchmark: { setup: asyncFunction, fn: sync },
        why: "an async setup",
        fragments: ["sort", "setup"],
      },
      {
        benchmark: { fn: sync, teardown: asyncFunction },
        why: "an async teardown",
        fragments: ["sort", "teardown"],
      },
    ])("throws a TypeError for $why", ({ benchmark, fragments }) => {
      const error = rejectionOf("sort", benchmark);

      expectTypeErrorHolding(error, fragments);
    });

    it("rejects it without calling it", () => {
      let calls = 0;
      const counted = async (): Promise<void> => {
        calls += 1;
      };

      thrownBy(() => {
        benchUnchecked("sort", counted);
      });

      expect(calls).toBe(0);
    });
  });

  describe("when given a function that is not async", () => {
    const returnsPromise = (): Promise<number> => Promise.resolve(1);

    it.each([
      { benchmark: generator, why: "a bare generator", fn: generator },
      { benchmark: returnsPromise, why: "a function returning a promise", fn: returnsPromise },
    ])("registers $why", ({ benchmark, fn }) => {
      benchUnchecked("sort", benchmark);

      expect(registeredCases().map((registered) => registered.case.fn)).toStrictEqual([fn]);
    });
  });

  describe("the default setup", () => {
    it("returns the same object on every call", () => {
      bench("sort", () => 1);
      const setup = registeredCases()[0]?.case.setup;

      const first = setup?.();
      const second = setup?.();

      expect(second).toBe(first);
    });
  });
});

describe("registeredCases", () => {
  describe("before any bench call", () => {
    it("returns no case", () => {
      expect(registeredCases()).toStrictEqual([]);
    });
  });

  describe("after several bench calls", () => {
    it("returns the cases in registration order", () => {
      bench("sort", () => 1);
      bench("search", () => 2);
      bench("concat", () => 3);

      const ids = registeredIds();

      expect(ids).toStrictEqual(["sort", "search", "concat"]);
    });

    it("returns both cases registered under one name, in order", () => {
      const first = (): number => 1;
      const second = (): number => 2;
      bench("sort", first);
      bench("sort", second);

      const idsAndFns = registeredCases().map((registered) => [registered.id, registered.case.fn]);

      expect(idsAndFns).toStrictEqual([
        ["sort", first],
        ["sort", second],
      ]);
    });
  });

  describe("when two copies of the module are loaded", () => {
    it("returns a case registered through the other copy", async () => {
      vi.resetModules();
      const writer = await import("../src/bench.js");
      vi.resetModules();
      const reader = await import("../src/bench.js");
      expect(reader.registeredCases).not.toBe(writer.registeredCases);
      const fn = (): number => 1;

      writer.bench("sort", fn);

      expect(reader.registeredCases().map((registered) => registered.case.fn)).toStrictEqual([fn]);
    });
  });
});

describe("the registry slot", () => {
  const CALLS = [
    {
      act: "bench",
      call: (): void => {
        bench("sort", () => 1);
      },
    },
    { act: "registeredCases", call: (): unknown => registeredCases() },
  ];

  describe("when it holds a value that is not an object", () => {
    beforeEach(() => {
      Reflect.set(globalThis, REGISTRY, "banana");
    });

    it.each(CALLS)("makes $act throw a TypeError naming the value found", ({ call }) => {
      const error = thrownBy(call);

      expectTypeErrorHolding(error, ["banana"]);
    });

    it.each(CALLS)("is left as it was by $act", ({ call }) => {
      thrownBy(call);

      expect(Reflect.get(globalThis, REGISTRY)).toBe("banana");
    });
  });

  describe("when it holds a format this copy does not know", () => {
    const slot = { format: 99 };

    beforeEach(() => {
      Reflect.set(globalThis, REGISTRY, slot);
    });

    it.each(CALLS)("makes $act throw a TypeError naming the format found", ({ call }) => {
      const error = thrownBy(call);

      expectTypeErrorHolding(error, ["99"]);
    });

    it.each(CALLS)("is left as it was by $act", ({ call }) => {
      thrownBy(call);

      expect(Reflect.get(globalThis, REGISTRY)).toBe(slot);
      expect(slot).toStrictEqual({ format: 99 });
    });
  });
});
