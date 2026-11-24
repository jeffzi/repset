import type { RepsetReading } from "../../scripts/check-timing-accuracy.js";

/** A repset reading whose timing lasted its `minTime`. */
export const READING: RepsetReading = {
  median: 1000,
  callsPerSample: 10,
  sampleCount: 64,
  timerResolutionNs: 40,
  timingMs: 1010,
  minTime: 1000,
};
