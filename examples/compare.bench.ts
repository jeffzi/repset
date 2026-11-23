// Scenario: compare implementations of the same task.
//
// Pass `fn` a record and each entry becomes a contender of one contest. repset runs the contest in
// repetitions of fresh processes and tells which contenders it can prove faster:
//
//   npx repset compare.bench.ts
import { bench } from "repset";

// Module code runs once per process, when the file loads, before any timing starts. Input that the
// functions only read can live here; it must be the same in every process.
const words = Array.from({ length: 2000 }, (_, index) => `word-${String((index * 7919) % 500)}`);

// Each function returns its result: repset consumes it, so the engine cannot delete the work.
bench("dedupe", {
  fn: {
    set: () => [...new Set(words)],
    "filter-index-of": () => words.filter((word, index) => words.indexOf(word) === index),
    "object-keys": () => {
      const seen: Record<string, true> = {};
      for (const word of words) seen[word] = true;
      return Object.keys(seen);
    },
  },
});
