// Scenario: compare implementations of the same task.
//
// Give each contender the same input and a name under one shared prefix, so one filter selects the
// whole group:
//
//   npx repset compare.bench.ts --filter '^dedupe/'
import { bench } from "repset";

// Module code runs once, when the file loads, before any timing starts. Input that the functions
// only read can live here.
const words = Array.from({ length: 2000 }, (_, index) => `word-${String((index * 7919) % 500)}`);

// Each function returns its result: repset consumes it, so the engine cannot delete the work.
bench("dedupe/set", () => [...new Set(words)]);

bench("dedupe/filter-index-of", () => words.filter((word, index) => words.indexOf(word) === index));

bench("dedupe/object-keys", () => {
  const seen: Record<string, true> = {};
  for (const word of words) seen[word] = true;
  return Object.keys(seen);
});
