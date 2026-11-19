# repset examples

Each `*.bench.ts` file below shows how to benchmark one common scenario with repset. Copy one into
your project, next to code that matches its scenario, and swap in your own functions. Put
`repset.config.ts` in the directory you run repset from. New to repset? The
[main README](../README.md) explains `bench()`, `setup` and `setupPerCall`.

| File                   | Scenario                                                      | Shows                                 |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------- |
| [compare.bench.ts]     | Compare implementations of the same task                      | a contest: `fn` as a record           |
| [input-sizes.bench.ts] | See how each implementation scales with the size of its input | `setup`, one benchmark per size       |
| [in-place.bench.ts]    | Time a function that changes its input                        | `setupPerCall`                        |
| [pool.bench.ts]        | Give back what a call took from a pool                        | `teardown` with `setupPerCall`        |
| [repset.config.ts]     | Keep a project's options in one file                          | `defineConfig`, `include`, `runtimes` |

## Run the examples

The examples import `repset` by its package name, which resolves to the built package in `dist/`.
Running them from a clone needs [mise](https://mise.jdx.dev/installing-mise.html), which installs
the Node and Bun versions the project uses. On a fresh clone, run `mise exec -- task install` once.

From the repository root, build the package, then run the command from this directory, where it
finds `repset.config.ts`:

```sh
mise exec -- task build
cd examples
mise exec -- node ../dist/cli.js
```

The config runs every case on Node, then on the Bun that mise installs. To run on Node alone, add
`--runtime node`.

In your own project, after `npm install --save-dev repset`, skip `task build` and write `npx repset`
wherever this page writes `mise exec -- node ../dist/cli.js` or `node ../dist/cli.js`.

## Common commands

A case's id is the name its `bench()` call gives it, followed by a contender's key in a contest,
such as `dedupe/set`. `node ../dist/cli.js --help` lists every option. The commands below leave out
the `mise exec --` prefix: add it unless mise is active in your shell.

| Command                                   | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `node ../dist/cli.js --once`              | Run every case once, without timing, to check it works                   |
| `node ../dist/cli.js --list`              | List the id of every case without running it                             |
| `node ../dist/cli.js compare.bench.ts`    | Run only the cases in that file                                          |
| `node ../dist/cli.js --filter '^dedupe/'` | Run the cases whose id starts with `dedupe/`                             |
| `node ../dist/cli.js --rounds 14`         | Run each contest in 14 rounds instead of the default                     |
| `node ../dist/cli.js --filter '/10000$'`  | Run the cases whose id ends with `/10000`                                |
| `node ../dist/cli.js --runtime node`      | Run on Node alone, overriding the config's `runtimes`                    |
| `node ../dist/cli.js -o report.json`      | Also write the JSON (JavaScript Object Notation) report to `report.json` |

[compare.bench.ts]: compare.bench.ts
[input-sizes.bench.ts]: input-sizes.bench.ts
[in-place.bench.ts]: in-place.bench.ts
[pool.bench.ts]: pool.bench.ts
[repset.config.ts]: repset.config.ts
