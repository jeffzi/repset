# repset

repset times synchronous JavaScript and TypeScript functions on Node and Bun.

## What repset is

You write a benchmark file that calls `bench()`, and repset times each benchmark in a fresh process
of its own on each runtime you name. It prints a table and can write a JSON report.

repset keeps its own code out of the timed loop, so the numbers measure your function rather than
the harness around it. That choice sets its limits:

- It times synchronous functions only. `bench()` rejects an `async` function.
- Each case runs in its own process, so one benchmark cannot slow the next. A run with many cases
  takes longer than an in-process tool.
- It gives no verdict between two cases, and none between two revisions of your code. It reports
  each case's numbers; a separate tool compares reports.

## Install

repset needs Node 26. Bun 1 is optional, as a second runtime to time the same cases on. Node cases
run on the Node that runs repset, and Bun cases on the first `bun` on your `PATH`.

```sh
npm install --save-dev repset
```

## Write a benchmark in three steps

A benchmark file is any file named `*.bench.ts`, `.mts`, `.js` or `.mjs`. Its top-level code calls
`bench()` once per benchmark.

### 1. Time a function

Pass a name and the function to time. Return the result of the work: repset consumes what the
function returns, which keeps the engine from deleting work whose result nothing uses.

```ts
// benchmarks/sort.bench.ts
import { bench } from "repset";

const input = Array.from({ length: 1000 }, (_, index) => (index * 7919) % 1000);

bench("sort/copy", () => input.toSorted((a, b) => a - b));
```

### 2. Build the state once with `setup`

When the function needs data built first, pass an object: `setup` builds the state off the clock,
and `fn` receives it. `setup` runs once, and every call of `fn` reuses its state.

Shared state fits a function that leaves its state as it found it, such as a search or a read. It
also fits one that changes its state while its cost stays the same from call to call, such as a
simulation step: the thousandth call must cost what the tenth did.

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

### 3. Give every call a fresh state with `setupPerCall`

A function that changes its state, such as an in-place sort, would measure something else on its
second call. Set `setupPerCall: true` and every call gets a state of its own: repset runs `setup`,
then times `fn` alone.

```ts
// benchmarks/sort-in-place.bench.ts
import { bench } from "repset";

bench("sort/in-place", {
  setup: () => Array.from({ length: 1000 }, (_, index) => (index * 7919) % 1000),
  fn: (values) => values.sort((a, b) => a - b),
  setupPerCall: true,
});
```

## Run it

`npx repset` runs every benchmark file under the current directory, skipping `node_modules`, on
Node:

```sh
npx repset
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

## Learn more

- `npx repset --help` lists every option.
- [examples/](https://github.com/jeffzi/repset/tree/main/examples) shows a benchmark file for each
  common scenario: comparing implementations, scaling with input size, mutating the input and
  returning objects to a pool.
- [VISION.md](https://github.com/jeffzi/repset/blob/main/VISION.md) says what repset is for and what
  it will not do.
