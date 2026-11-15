import { describe, expect, it } from "vitest";

import { summarize } from "../../src/measure/measure.js";

describe("summarize", () => {
  describe("when the spans are stored ascending", () => {
    it("reports per-call nanoseconds with percentiles interpolated between ranks", () => {
      const spans = Float64Array.of(4, 8, 12, 16);

      const statistics = summarize(spans, 4, 4);

      expect(statistics).toStrictEqual({
        min: 1_000_000,
        p25: 1_750_000,
        median: 2_500_000,
        p75: 3_250_000,
        p99: expect.closeTo(3_970_000, 3),
        max: 4_000_000,
        mean: 2_500_000,
        sampleCount: 4,
      });
    });
  });

  describe("when the spans are stored out of order", () => {
    it("reports the same statistics as the ascending store", () => {
      const ascending = summarize(Float64Array.of(4, 8, 12, 16), 4, 4);

      const shuffled = summarize(Float64Array.of(12, 4, 16, 8), 4, 4);

      expect(shuffled).toStrictEqual(ascending);
    });
  });

  describe("when the store is only partly filled", () => {
    it("ignores the slots past the stored count", () => {
      const spans = new Float64Array(8);
      spans.set([2, 6, 4]);

      const statistics = summarize(spans, 3, 2);

      expect(statistics).toStrictEqual({
        min: 1_000_000,
        p25: 1_500_000,
        median: 2_000_000,
        p75: 2_500_000,
        p99: expect.closeTo(2_980_000, 3),
        max: 3_000_000,
        mean: 2_000_000,
        sampleCount: 3,
      });
    });
  });
});
