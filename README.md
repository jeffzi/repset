# repset

repset times synchronous JavaScript and TypeScript functions on Node and Bun.

- [What repset is](#what-repset-is)
- [Install](#install)
- [Write a benchmark in three steps](#write-a-benchmark-in-three-steps)
- [Run the benchmarks](#run-the-benchmarks)
- [Compare functions in a contest](#compare-functions-in-a-contest)
- [Configure a project](#configure-a-project)
- [Learn more](#learn-more)
- [License](#license)

## What repset is

You write a benchmark file that calls `bench()`, and repset times each case in a fresh process of
its own on each runtime you name. It prints a table and can write a JSON (JavaScript Object
Notation) report.

repset keeps its own code out of the timed loop, so the numbers measure your function rather than
the harness around it. That choice sets its limits:

- It times synchronous functions only. `bench()` rejects an `async` function.
- Each case runs in its own process, so one case cannot slow the next. A run with many cases takes
  longer than an in-process tool.
- It gives no verdict between two revisions of your code. It reports each run's numbers; a
  comparison tool such as [gymrat](https://github.com/jeffzi/gymrat) compares reports. Between
  functions in one file, a [contest](#compare-functions-in-a-contest) gives the verdict.

## Install

repset needs Node 26. Bun 1 is optional, as a second runtime to time the same cases on. Node cases
run on the Node that runs repset, and Bun cases on the first `bun` on your `PATH`.

```sh
npm install --save-dev repset
```

## Write a benchmark in three steps

By default, a benchmark file is any file named `*.bench.ts`, `.mts`, `.js` or `.mjs`. Its top-level
code calls `bench()` once per case.

### 1. Time a function

Pass a name and the function to time. Return the result of the work: repset consumes what the
function returns, which keeps the engine from deleting work whose result nothing uses. The name is
the case's id, which the table shows and `--filter` matches.

<!-- docs CODE
  src="./docs/snippets/sort.bench.ts"
  header="// benchmarks/sort.bench.ts"
-->

```ts
// benchmarks/sort.bench.ts
import { bench } from "repset";

const SIZE = 1000;
// Prime, so the stride visits every value once.
const STRIDE = 7919;
const shuffled = Array.from({ length: SIZE }, (_, index) => (index * STRIDE) % SIZE);

bench("sort/copy", () => shuffled.toSorted((a, b) => a - b));
```

<!-- /docs -->

### 2. Build the state once with `setup`

When the function needs data built first, pass an object: `setup` builds the state off the clock,
and `fn` receives it. `setup` runs once, and every call of `fn` reuses its state.

Shared state fits a function that leaves its state as it found it, such as a search or a read. It
also fits one that changes its state while its cost stays the same from call to call, such as a
simulation step. The thousandth call must cost what the tenth did.

<!-- docs CODE
  src="./docs/snippets/search.bench.ts"
  header="// benchmarks/search.bench.ts"
-->

```ts
// benchmarks/search.bench.ts
import { bench } from "repset";

function binarySearch(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle] ?? 0;
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

bench("search/binary", {
  setup: () => Array.from({ length: 10_000 }, (_, index) => index * 2),
  fn: (values) => binarySearch(values, 4242),
});
```

<!-- /docs -->

### 3. Give every call a fresh state with `setupPerCall`

A function that changes its state, such as an in-place sort, would measure something else on its
second call. Set `setupPerCall: true` and every call gets a state of its own: repset runs `setup`,
times `fn` alone, then runs `teardown` if you give one. `teardown` receives the state and runs off
the clock, such as to return an object to a pool.

<!-- docs CODE
  src="./docs/snippets/sort-in-place.bench.ts"
  header="// benchmarks/sort-in-place.bench.ts"
-->

```ts
// benchmarks/sort-in-place.bench.ts
import { bench } from "repset";

const SIZE = 1000;
// Prime, so the stride visits every value once.
const STRIDE = 7919;

bench("sort/in-place", {
  setup: () => Array.from({ length: SIZE }, (_, index) => (index * STRIDE) % SIZE),
  fn: (values) => values.sort((a, b) => a - b),
  setupPerCall: true,
});
```

<!-- /docs -->

## Run the benchmarks

`npx repset` runs every benchmark file under the current directory, skipping `node_modules`, on
Node. A config file changes which files and runtimes it uses (see
[Configure a project](#configure-a-project)).

```sh
npx repset
```

repset prints a table with one section per runtime. Each row gives a case's median, mean, minimum
and maximum time per call, each with its own unit, and the number of samples:

```text
node 26.13.1
──────────────┬─────────┬─────────┬─────────┬─────────┬────────
case          │  median │    mean │     min │     max │ samples
──────────────┼─────────┼─────────┼─────────┼─────────┼────────
sort/copy     │ 75.6 µs │ 76.9 µs │ 72.8 µs │  162 µs │   12985
search/binary │ 10.5 ns │ 10.8 ns │ 10.3 ns │ 73.2 ns │  114940
sort/in-place │ 77.7 µs │ 79.6 µs │ 74.5 µs │  171 µs │    9304

Each case was measured once, in its own process. A verdict between revisions takes a comparison tool.
```

Common options:

| Command                               | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `npx repset benchmarks/sort.bench.ts` | Run only the cases in that file                         |
| `npx repset --filter '^sort/'`        | Run the cases whose id starts with `sort/`              |
| `npx repset --runtime node,bun`       | Run every case on Node, then on Bun                     |
| `npx repset --measure time,memory`    | Measure each case's time and memory                     |
| `npx repset -o report.json`           | Also write the JSON report to `report.json`             |
| `npx repset --once`                   | Run every case once, without timing, to check it works  |
| `npx repset -d`                       | Print each failed case's stack and its process's output |

Node runs TypeScript files by stripping their types, but it does not map an import of `./foo.js` to
`foo.ts`. If your benchmarks import TypeScript files that way, give Node a loader such as
[tsx](https://github.com/privatenumber/tsx): `npx repset --node-import tsx`. Bun needs none.

## Measure memory

`--measure time,memory` adds the heap bytes one call of `fn` allocates to each case, in a `memory`
column at the end of the table. `--measure memory` reads bytes alone and skips timing, so it runs
faster. The default is `--measure time`.

```sh
npx repset --measure time,memory
```

```text
node 26.13.1
──────────────┬─────────┬─────────┬─────────┬────────┬─────────┬────────
case          │  median │    mean │     min │    max │ samples │  memory
──────────────┼─────────┼─────────┼─────────┼────────┼─────────┼────────
sort/copy     │ 75.1 µs │ 76.4 µs │ 72.7 µs │ 151 µs │   13071 │ 26.2 kB
sort/in-place │ 77.3 µs │ 78.3 µs │ 75.0 µs │ 204 µs │    9451 │ 17.5 kB
search/binary │ 10.8 ns │ 11.0 ns │ 10.4 ns │ 250 ns │  113348 │  0.00 B
```

- **What it counts.** On Node, the JavaScript heap (`heapUsed`). An `ArrayBuffer`'s backing store
  lives outside it: a 1 KiB `Uint8Array` reads only its 200 bytes on the heap. Bun has no heap
  reading, so its rows show `n/a`, and `--measure memory` on Bun alone exits with an error.
- **How exact it is.** repset subtracts the bytes of an empty function measured the same way, so a
  body that allocates nothing reads 0. A reading is held to the larger of 8 bytes per call and 0.2 %
  of what the body allocates. repset reports the bytes and never judges them against a budget.
- **When a collection interferes.** A garbage collection inside a sample frees part of what it
  measures, so repset discards that sample and takes it again with fewer calls. A row reads
  `no clean pair` when every sample was disturbed.
- **With `setupPerCall`.** To read memory, repset sets up every call of a sample before it runs the
  first, so one sample's per-call states are alive together. To read an empty call, it also sets up
  and tears down states it never passes to `fn`. State shared across calls, such as a pool or a
  cache, must not assume one call at a time, or that `fn` runs on every state.
- **In a contest.** repset reads each contender's memory once, in its first repetition: bytes per
  call agree across processes where times do not. Ranks and ratios still come from time. A contest
  measured for memory alone shows each contender's bytes and ranks nothing.

A number kept across calls allocates once it outgrows a small integer: on Node, every add past 2³¹ −
1 allocates 16 bytes. If `fn` adds into a module-level sink that is never reset, its bytes per call
then depend on how many calls ran before. Keep such a sink small, for example
`sink = (sink + x) & 0x3fffffff`.

## Compare functions in a contest

To find which of several functions is faster, pass `fn` a record instead of a function. Each entry
is a contender, and its case id is the benchmark's name and its key: `concat/loop` and
`concat/join`. The contenders share `setup`, `teardown` and `setupPerCall`, so they time the same
work on the same state.

<!-- docs CODE
  src="./docs/snippets/concat.bench.ts"
  header="// benchmarks/concat.bench.ts"
-->

```ts
// benchmarks/concat.bench.ts
import { bench } from "repset";

/** `count` short words, the same in every process, as each process runs `setup` on its own. */
function words(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `word${String(index % 100)}`);
}

bench("concat", {
  setup: () => words(1000),
  fn: {
    loop: (list) => {
      let text = "";
      for (const word of list) text += word;
      return text;
    },
    join: (list) => list.join(""),
  },
});
```

<!-- /docs -->

One process per contender cannot order them: two processes of the same code can read several percent
apart. So repset runs a contest in repetitions. Each repetition starts one fresh process per
contender, in an order drawn at random from a seed the report records. Then repset tests every pair
of contenders over the repetitions, with an exact
[signed-rank test](https://en.wikipedia.org/wiki/Wilcoxon_signed-rank_test) and
[Holm's correction](https://en.wikipedia.org/wiki/Holm%E2%80%93Bonferroni_method) across the
contest's pairs. Holm's correction raises the bar each pair must clear, so testing many pairs does
not add false verdicts:

```text
node 26.13.1

concat · 7 repetitions
──────────┬─────────┬───────┬─────
contender │  median │ ratio │ rank
──────────┼─────────┼───────┼─────
loop      │ 2.73 µs │ 1.00× │    1
join      │ 8.46 µs │ 3.10× │    2
```

- **Ratio** is each contender's time over the first row's. The JSON report holds each pair's 95 %
  confidence interval. With more than two contenders the level rises to cover every pair, so each
  interval widens.
- **Rank** is 1 plus the number of contenders proven faster. Two contenders share a rank when the
  repetitions did not tell them apart. A pair is also tied when its gap is within 1.25 times the
  timer's resolution per call. When the repetitions leave pairs tied, a line under the contest's
  table names those pairs and suggests twice as many repetitions:
  `npx repset --contest-repetition-count 14`. Pairs whose gap is too small for the timer get no such
  suggestion, since more repetitions do not help.
- **Repetitions** default to the fewest at which one repetition may disagree and the pair can still
  be judged: 7 for two contenders, 8 for three, 12 for eight. `--contest-repetition-count` sets
  another count.

Each repetition starts one process per contender, and each process takes as long as one plain case.
Judging is exact at every count, and its cost grows with the cube of the repetitions: 38 ms per pair
at 200 repetitions, about 2 seconds at 800.

Each process runs `setup` on its own, so `setup` must build the same state every time: random data
needs a fixed seed.

Only a contest is judged. Two plain benchmarks under one prefix, such as `sort/copy` and
`sort/in-place`, each run once with no verdict between them.

## Configure a project

repset reads `repset.config.ts` (or `.mts`, `.js`, `.mjs`) from the directory it starts in, or the
file `--config` names. The file default-exports its options through `defineConfig`:

```ts
// repset.config.ts
import { defineConfig } from "repset";

export default defineConfig({
  // Globs are relative to this file.
  include: ["benchmarks/*.bench.ts"],
  runtimes: ["node", "bun"],
});
```

| Option                   | Flag                         | What it sets                                                                                            | Default                      |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `include`                | file arguments               | Globs for benchmark files, relative to the config file                                                  | `**/*.bench.{ts,mts,js,mjs}` |
| `runtimes`               | `--runtime`                  | Runtimes to run on, in this order                                                                       | `["node"]`                   |
| `minTime`                | `--min-time`                 | Milliseconds to time each case for, at least                                                            | `1000`                       |
| `minSampleCount`         | `--min-sample-count`         | Samples to take of each case, at least                                                                  | `64`                         |
| `contestRepetitionCount` | `--contest-repetition-count` | Repetitions each contest runs                                                                           | by contest size              |
| `timeout`                | `--timeout`                  | Milliseconds one process may run before its case fails                                                  | `600000`                     |
| `nodeImport`             | `--node-import`              | Module Node loads first; a `./` or `../` path is relative to the config file. Bun ignores it            | none                         |
| `measure`                | `--measure`                  | What to measure of each case: `time`, `memory` or both                                                  | `["time"]`                   |
| `debug`                  | `-d`, `--debug`              | Print each failed case's stack and its process's output, and keep each measurement's `gc` in the report | `false`                      |

A flag on the command line overrides the file: `npx repset --runtime node` runs Node alone.

## Learn more

- `npx repset --help` lists every option.
- [examples/](https://github.com/jeffzi/repset/tree/main/examples) shows a benchmark file for each
  common scenario: comparing implementations, scaling with input size, mutating the input and
  returning objects to a pool with `teardown`.
- [VISION.md](https://github.com/jeffzi/repset/blob/main/VISION.md) says what repset is for and what
  it will not do.

## License

MIT. See [LICENSE](https://github.com/jeffzi/repset/blob/main/LICENSE).
