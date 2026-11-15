import { beforeEach, describe, expect, it, vi } from "vitest";

import { bench, registeredCases } from "../src/bench.js";

const REGISTRY = Symbol.for("repset.registry");

/** Runs `act` and returns what it threw. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Calls `bench` with arguments its signature rejects at compile time. */
function benchUnchecked(name: unknown, benchmark: unknown): void {
  Reflect.apply(bench, undefined, [name, benchmark]);
}

/** Registers one case, makes a bad `bench` call, and returns its error and the ids registered. */
function rejectionOf(name: unknown, benchmark: unknown): { error: unknown; ids: string[] } {
  bench("before", () => 1);
  const error = thrownBy(() => {
    benchUnchecked(name, benchmark);
  });
  return { error, ids: registeredCases().map((registered) => registered.id) };
}

/** Asserts a TypeError holding every fragment, and that the call registered nothing. */
function expectRejected(rejection: { error: unknown; ids: string[] }, fragments: string[]): void {
  expect(rejection.error).toBeInstanceOf(TypeError);
  for (const fragment of fragments) {
    expect(String(rejection.error)).toContain(fragment);
  }
  expect(rejection.ids).toStrictEqual(["before"]);
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
  Reflect.deleteProperty(globalThis, REGISTRY);
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

    it("registers a setup that returns an empty object", () => {
      bench("sort", () => 1);

      expect(registeredCases()[0]?.case.setup()).toStrictEqual({});
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

    it("registers no teardown key when it has no teardown", () => {
      const setup = (): number => 1;
      const fn = (value: number): number => value + 1;

      bench("sort", { setup, fn });

      expect(registeredCases()).toStrictEqual([
        { id: "sort", case: { kind: "sharedState", setup, fn } },
      ]);
    });

    it("registers the default setup when it has no setup", () => {
      bench("bare", () => 1);
      bench("object", { fn: () => 1 });

      const [bare, object] = registeredCases();

      expect(object?.case.setup()).toBe(bare?.case.setup());
    });

    it("registers what their absence registers for fields set to undefined", () => {
      const fn = (): number => 1;
      bench("bare", fn);

      bench("object", { setup: undefined, fn, teardown: undefined, setupPerCall: undefined });

      const [bare, object] = registeredCases();
      expect(object).toStrictEqual({
        id: "object",
        case: { kind: "sharedState", setup: expect.any(Function), fn },
      });
      expect(object?.case.setup()).toBe(bare?.case.setup());
    });
  });

  describe("when given a name that is not a string", () => {
    it("throws a TypeError holding the value and registers nothing", () => {
      const rejection = rejectionOf(42, sync);

      expectRejected(rejection, ["42"]);
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
      const rejection = rejectionOf(name, sync);

      expectRejected(rejection, [name]);
    });
  });

  describe("when given a name of several segments that keeps the name rule", () => {
    it("registers the case under that name", () => {
      bench("sort/in-place_v1.2", sync);

      expect(registeredCases().map((registered) => registered.id)).toStrictEqual([
        "sort/in-place_v1.2",
      ]);
    });
  });

  describe("when given a second argument that is not a function or an object", () => {
    it.each([
      { benchmark: 42, why: "a number", fragments: ["sort", "42"] },
      { benchmark: "banana", why: "a string", fragments: ["sort", "banana"] },
      { benchmark: undefined, why: "undefined", fragments: ["sort", "undefined"] },
      { benchmark: null, why: "null", fragments: ["sort", "null"] },
      { benchmark: [sync], why: "an array", fragments: ["sort", "an array"] },
    ])("throws a TypeError for $why", ({ benchmark, fragments }) => {
      const rejection = rejectionOf("sort", benchmark);

      expectRejected(rejection, fragments);
    });
  });

  describe("when given a benchmark object with a field repset does not know", () => {
    it.each([
      { benchmark: { fn: sync, banana: 1 }, field: "banana" },
      { benchmark: { fn: sync, params: { size: [10] } }, field: "params" },
    ])("throws a TypeError holding the field $field", ({ benchmark, field }) => {
      const rejection = rejectionOf("sort", benchmark);

      expectRejected(rejection, ["sort", field]);
    });
  });

  describe("when given a benchmark object with a field of the wrong type", () => {
    it.each([
      { benchmark: { setup: sync }, why: "fn missing", field: "fn" },
      { benchmark: { fn: undefined }, why: "fn undefined", field: "fn" },
      { benchmark: { fn: 42 }, why: "fn a number", field: "fn" },
      { benchmark: { fn: { run: sync } }, why: "fn a record of functions", field: "fn" },
      { benchmark: { fn: null }, why: "fn null", field: "fn" },
      { benchmark: { fn: sync, setup: 42 }, why: "setup a number", field: "setup" },
      { benchmark: { fn: sync, setup: null }, why: "setup null", field: "setup" },
      { benchmark: { fn: sync, teardown: 42 }, why: "teardown a number", field: "teardown" },
      { benchmark: { fn: sync, teardown: null }, why: "teardown null", field: "teardown" },
      {
        benchmark: { fn: sync, setupPerCall: "yes" },
        why: "setupPerCall a string",
        field: "setupPerCall",
      },
      {
        benchmark: { fn: sync, setupPerCall: null },
        why: "setupPerCall null",
        field: "setupPerCall",
      },
    ])("throws a TypeError holding the field for $why", ({ benchmark, field }) => {
      const rejection = rejectionOf("sort", benchmark);

      expectRejected(rejection, ["sort", field]);
    });

    it("names a function given as setupPerCall without printing its source", () => {
      const rejection = rejectionOf("sort", { fn: sync, setupPerCall: sync });

      expectRejected(rejection, ["sort", "setupPerCall", "a function"]);
      expect(String(rejection.error)).not.toContain("=>");
    });
  });

  describe("when given an async function", () => {
    it.each([
      { benchmark: asyncFunction, why: "a bare async function", fragments: ["sort"] },
      { benchmark: asyncGenerator, why: "a bare async generator", fragments: ["sort"] },
      { benchmark: { fn: asyncFunction }, why: "an async fn", fragments: ["sort", "fn"] },
      {
        benchmark: { fn: asyncGenerator },
        why: "an async generator fn",
        fragments: ["sort", "fn"],
      },
      {
        benchmark: { setup: asyncFunction, fn: sync },
        why: "an async setup",
        fragments: ["sort", "setup"],
      },
      {
        benchmark: { setup: asyncGenerator, fn: sync },
        why: "an async generator setup",
        fragments: ["sort", "setup"],
      },
      {
        benchmark: { fn: sync, teardown: asyncFunction },
        why: "an async teardown",
        fragments: ["sort", "teardown"],
      },
      {
        benchmark: { fn: sync, teardown: asyncGenerator },
        why: "an async generator teardown",
        fragments: ["sort", "teardown"],
      },
    ])("throws a TypeError for $why", ({ benchmark, fragments }) => {
      const rejection = rejectionOf("sort", benchmark);

      expectRejected(rejection, fragments);
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
      { benchmark: { fn: generator }, why: "a generator fn", fn: generator },
      { benchmark: returnsPromise, why: "a function returning a promise", fn: returnsPromise },
    ])("registers $why", ({ benchmark, fn }) => {
      benchUnchecked("sort", benchmark);

      expect(registeredCases().map((registered) => registered.case.fn)).toStrictEqual([fn]);
    });
  });

  describe("the default setup", () => {
    it("returns a frozen object", () => {
      bench("sort", () => 1);

      const state = registeredCases()[0]?.case.setup();

      expect(Object.isFrozen(state)).toBe(true);
    });

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

      const ids = registeredCases().map((registered) => registered.id);

      expect(ids).toStrictEqual(["sort", "search", "concat"]);
    });

    it("returns both cases registered under one name, in order", () => {
      const first = (): number => 1;
      const second = (): number => 2;
      bench("sort", first);
      bench("sort", second);

      const fns = registeredCases().map((registered) => [registered.id, registered.case.fn]);

      expect(fns).toStrictEqual([
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

      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toContain("banana");
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

      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toContain("99");
    });

    it.each(CALLS)("is left as it was by $act", ({ call }) => {
      thrownBy(call);

      expect(Reflect.get(globalThis, REGISTRY)).toBe(slot);
      expect(slot).toStrictEqual({ format: 99 });
    });
  });
});
