# repset examples

Each file below shows how to benchmark one common scenario with repset. Copy one into your project,
next to code that matches its scenario, and swap in your own functions. New to repset? The
[main README](../README.md) explains `bench()`, `setup` and `setupPerCall`.

| File                   | Scenario                                                      | Shows                                      |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| [compare.bench.ts]     | Compare implementations of the same task                      | a function passed to `bench()`, `--filter` |
| [input-sizes.bench.ts] | See how each implementation scales with the size of its input | `setup`, one benchmark per size            |
| [in-place.bench.ts]    | Time a function that changes its input                        | `setupPerCall`                             |
| [pool.bench.ts]        | Give back what a call took from a pool                        | `teardown`                                 |
| [repset.config.ts]     | Keep a project's options in one file                          | `defineConfig`, `include`, `runtimes`      |

## Run the examples

The examples import `repset` by its package name, which resolves to the built package in `dist/`.
Running them from a clone needs Node 26 and [mise](https://mise.jdx.dev/installing-mise.html). On a
fresh clone, run `mise exec -- task install` once.

From the repository root, build the package, then run the command from this directory, where it
finds `repset.config.ts`:

```sh
task build
cd examples
node ../dist/cli.js
```

The config runs every case on Node, then on Bun. Without Bun on your `PATH`, add `--runtime node`.

In your own project, after `npm install --save-dev repset`, skip `task build` and write `npx repset`
wherever this page writes `node ../dist/cli.js`.

## Common commands

A case's id is the name its `bench()` call gives it, such as `dedupe/set`.
`node ../dist/cli.js --help` lists every option.

| Command                                   | What it does                                            |
| ----------------------------------------- | ------------------------------------------------------- |
| `node ../dist/cli.js --once`              | Runs every case once, without timing, to check it works |
| `node ../dist/cli.js --list`              | Prints the id of every case and exits                   |
| `node ../dist/cli.js compare.bench.ts`    | Runs the cases of that file only                        |
| `node ../dist/cli.js --filter '^dedupe/'` | Runs the cases whose id matches the regular expression  |
| `node ../dist/cli.js --filter '/10000$'`  | Runs the largest input of every search                  |
| `node ../dist/cli.js --runtime node`      | Runs on Node alone, overriding the config's `runtimes`  |
| `node ../dist/cli.js --out report.json`   | Also writes the JSON report to `report.json`            |

[compare.bench.ts]: compare.bench.ts
[input-sizes.bench.ts]: input-sizes.bench.ts
[in-place.bench.ts]: in-place.bench.ts
[pool.bench.ts]: pool.bench.ts
[repset.config.ts]: repset.config.ts
