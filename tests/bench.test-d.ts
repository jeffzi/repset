import { assertType, describe, expectTypeOf, it } from "vitest";

import { bench } from "../src/bench.js";

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
});
