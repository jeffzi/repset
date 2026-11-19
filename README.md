# repset

repset times synchronous JavaScript and TypeScript functions on Node and Bun.

## What repset is

You write a benchmark file that calls `bench()`, and repset times each case in a fresh process of
its own on each runtime you name. It prints a table and can write a JSON (JavaScript Object
Notation) report.

repset keeps its own code out of the timed loop, so the numbers measure your function rather than
the harness around it. That choice sets its limits:

- It times synchronous functions only. `bench()` rejects an `async` function.
- Each case runs in its own process, so one case cannot slow the next. A run with many cases takes
  longer than an in-process tool.
- It gives no verdict between two cases, and none between two revisions of your code. It reports
  each case's numbers; a separate tool compares reports.

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
simulation step: the thousandth call must cost what the tenth did.

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

## Run it

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

| Command                               | What it does                                            |
| ------------------------------------- | ------------------------------------------------------- |
| `npx repset benchmarks/sort.bench.ts` | Runs the benchmarks of that file only                   |
| `npx repset --filter '^sort/'`        | Runs the cases whose id matches the regular expression  |
| `npx repset --runtime node,bun`       | Runs every case on Node, then on Bun                    |
| `npx repset --out report.json`        | Writes the JSON report to `report.json`                 |
| `npx repset --once`                   | Runs every case once, without timing, to check it works |

Node runs TypeScript files by stripping their types, but it does not map an import of `./foo.js` to
`foo.ts`. If your benchmarks import TypeScript files that way, give Node a loader such as
[tsx](https://github.com/privatenumber/tsx): `npx repset --node-import tsx`. Bun needs none.

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

The options are `include`, `runtimes`, `minTime`, `minSamples`, `timeout` and `nodeImport`. A flag
on the command line overrides the file: `npx repset --runtime node` runs Node alone.

## Learn more

- `npx repset --help` lists every option.
- [examples/](https://github.com/jeffzi/repset/tree/main/examples) shows a benchmark file for each
  common scenario: comparing implementations, scaling with input size, mutating the input and
  returning objects to a pool with `teardown`.
- [VISION.md](https://github.com/jeffzi/repset/blob/main/VISION.md) says what repset is for and what
  it will not do.

## License

MIT. See [LICENSE](https://github.com/jeffzi/repset/blob/main/LICENSE).
