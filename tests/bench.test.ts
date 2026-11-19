import { beforeEach, describe, expect, it, vi } from "vitest";

import { bench, registeredCases } from "../src/child.js";
import { errorOf } from "./error-of.js";
import { REGISTRY, resetRegistry } from "./registry.js";

/** Returns the ids of the registered cases, in registration order. */
function registeredIds(): string[] {
  return registeredCases().map((registered) => registered.id);
}

/** Calls `bench` with arguments its signature rejects at compile time. */
function benchUnchecked(name: unknown, benchmark: unknown): void {
  Reflect.apply(bench, undefined, [name, benchmark]);
}

/** Makes a bad `bench` call and returns what it threw. */
function rejectionOf(name: unknown, benchmark: unknown): Error {
  return errorOf(() => {
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

      expect([bare?.id, object?.id]).toStrictEqual(["bare", "object"]);
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
    ])("throws a TypeError holding the quoted name when it has $why", ({ name }) => {
      const error = rejectionOf(name, sync);

      expectTypeErrorHolding(error, [JSON.stringify(name)]);
    });
  });

  describe("when given a name of several segments that keeps the name rule", () => {
    it("registers the case under that name", () => {
      bench("sort/in-place_v1.2", sync);

      expect(registeredIds()).toStrictEqual(["sort/in-place_v1.2"]);
    });
  });

  describe("when given a second argument that is not a function or an object", () => {
    it("throws a TypeError naming the value", () => {
      const error = rejectionOf("sort", 42);

      expectTypeErrorHolding(error, ["sort", "42"]);
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
    ])("throws a TypeError for $why", ({ benchmark, fragments }) => {
      const error = rejectionOf("sort", benchmark);

      expectTypeErrorHolding(error, fragments);
    });

    it("rejects it without calling it", () => {
      let calls = 0;
      const counted = async (): Promise<void> => {
        calls += 1;
      };

      errorOf(() => {
        benchUnchecked("sort", counted);
      });

      expect(calls).toBe(0);
    });
  });

  describe("when given a function that is not async", () => {
    const returnsPromise = (): Promise<number> => Promise.resolve(1);

    it.each([
      { benchmark: generator, why: "a bare generator" },
      { benchmark: returnsPromise, why: "a function returning a promise" },
    ])("registers $why", ({ benchmark }) => {
      bench("sort", benchmark);

      expect(registeredCases().map((registered) => registered.case.fn)).toStrictEqual([benchmark]);
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
      const writer = await import("../src/child.js");
      vi.resetModules();
      const reader = await import("../src/child.js");
      expect(reader.registeredCases).not.toBe(writer.registeredCases);
      const fn = (): number => 1;

      writer.bench("sort", fn);

      expect(reader.registeredCases().map((registered) => registered.case.fn)).toStrictEqual([fn]);
    });
  });

  describe("when the registry slot holds a value that is not an object", () => {
    beforeEach(() => {
      Reflect.set(globalThis, REGISTRY, "banana");
    });

    it("throws a TypeError naming the value found", () => {
      const error = errorOf(registeredCases);

      expectTypeErrorHolding(error, ["banana"]);
    });
  });

  describe("when the registry slot holds a format this copy does not know", () => {
    const slot = { format: 99 };

    beforeEach(() => {
      Reflect.set(globalThis, REGISTRY, slot);
    });

    it("throws a TypeError naming the format found", () => {
      const error = errorOf(registeredCases);

      expectTypeErrorHolding(error, ["99"]);
    });
  });
});
