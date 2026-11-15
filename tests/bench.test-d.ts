import { assertType, describe, expectTypeOf, it } from "vitest";

import { type Benchmark, bench } from "../src/bench.js";

/** Asserts that the `bench()` calls in `register` type-check, or fail where `@ts-expect-error` says. */
function assertCompiles(register: () => void): void {
  assertType<() => void>(register);
}

describe("bench", () => {
  describe("when the benchmark object has a setup", () => {
    it("types fn and teardown to receive what setup returns", () => {
      bench("sort", {
        setup: () => [3, 1, 2],
        fn: (values) => {
          expectTypeOf(values).toEqualTypeOf<number[]>();
        },
        teardown: (values) => {
          expectTypeOf(values).toEqualTypeOf<number[]>();
        },
      });
    });

    it("rejects a fn whose parameter type differs from what setup returns", () => {
      assertCompiles(() => {
        bench("sort", {
          setup: () => [3, 1, 2],
          // @ts-expect-error -- fn takes a string, setup returns numbers
          fn: (text: string) => text.length,
        });
      });
    });
  });

  describe("when there is no setup", () => {
    it("accepts a bare fn that takes no parameter", () => {
      assertCompiles(() => {
        bench("sort", () => 1);
      });
    });

    it("accepts a benchmark object whose fn takes no parameter", () => {
      assertCompiles(() => {
        bench("sort", { fn: () => 1 });
      });
    });

    it("rejects a bare fn whose parameter requires a key", () => {
      assertCompiles(() => {
        // @ts-expect-error -- the empty parameter combination has no key
        bench("sort", (combination: { readonly size: number }) => combination.size);
      });
    });

    it("rejects a benchmark object whose fn parameter requires a key", () => {
      assertCompiles(() => {
        bench("sort", {
          // @ts-expect-error -- the empty parameter combination has no key
          fn: (combination: { readonly size: number }) => combination.size,
        });
      });
    });
  });

  describe("when a field is set to undefined", () => {
    it("accepts setup, teardown and setupPerCall set to undefined", () => {
      assertCompiles(() => {
        bench("sort", {
          setup: undefined,
          fn: () => 1,
          teardown: undefined,
          setupPerCall: undefined,
        });
      });
    });

    it("accepts a Benchmark whose setup, teardown and setupPerCall are undefined", () => {
      assertType<Benchmark<number[]>>({
        setup: undefined,
        fn: () => 1,
        teardown: undefined,
        setupPerCall: undefined,
      });
    });
  });
});
