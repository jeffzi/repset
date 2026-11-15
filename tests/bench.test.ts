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
