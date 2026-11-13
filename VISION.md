# repset vision

repset measures the time and allocation of synchronous JavaScript hot paths, each benchmark in its
own process on each JavaScript engine, starting with [Node][node] and [Bun][bun]. A benchmark
declares contenders, the alternatives it compares. repset runs each contender in several fresh
processes, then says which is faster or that it cannot tell them apart. A run can also write a JSON
report. It competes with [mitata][mitata], [tinybench][tinybench], [Deno.bench][deno-bench] and
[`node:bench`][node-bench]: the in-process tools a TypeScript author reaches for first.

## Problem

Most JavaScript benchmark libraries wrap the body, the function a benchmark times, in code that
changes how the JIT compiles it. One body of about 1 µs, calling a small function per element, reads
differently depending on what surrounds it (Apple M2 Max, Node 26.8.1, Bun 1.4.0):

| Engine | Harness around the body          | Median  |
| ------ | -------------------------------- | ------- |
| Node   | plain loop                       | 1110 ns |
| Node   | `try` region                     | 2866 ns |
| Node   | mitata's `AsyncFunction` sampler | 2917 ns |
| Bun    | plain loop                       | 625 ns  |
| Bun    | tinybench's `try`/`finally`      | 875 ns  |

The `try` and sampler rows measure the harness, not the body.

Deno.bench and `node:bench` let the body start and stop the clock itself with `b.start()` and
`b.end()`, so its setup stays off the clock. For a body under 10 µs, Deno.bench ignores those calls,
so setup is timed with the body. Both run every benchmark of a file in the same isolate or process,
so one benchmark can slow the next (#6). Libraries that keep setup off the clock through hooks
instead, such as tinybench, keep adding events and options until writing a benchmark means learning
the library.

## Principles

The numbers rank the principles: when two conflict, the lower number wins. Each principle ends with
requests it rules out.

1. **Honest numbers over convenience.** The API offers only benchmark forms that repset can time
   correctly. Bodies are synchronous, and setup and teardown run outside every pair of clock reads.
   No `try`, `async` or Promise sits between repset's timing loop and the body, and a body never
   reports its own duration. Rules out: a body that returns `{ overriddenDuration }`; setup inside
   the timed window to save a callback.

2. **One way to do each thing.** Each need has exactly one mechanism. A benchmark has one setup, one
   teardown and one place for its options. Rules out: a suite-level `beforeEach` on top of a
   benchmark's setup; event listeners; a second registration function, such as `compare()` or
   `suite.add()`; an option that restates another, as `warmupIterations` beside `iterations`.

3. **Each step adds one idea.** A bare function is a complete benchmark. Each further need adds one
   field to the same object: `setup` builds data off the clock, `setupPerCall` rebuilds it before
   every call, and `params` runs the benchmark over several inputs. Rules out: anything a beginner
   must learn before timing one function, such as a class, a required config file or a hook such as
   `beforeAll`.

4. **Measured defaults over knobs.** Every default comes from a measurement. A knob exists only when
   a measurement shows the default wrong for a real benchmark. A setting that never changes a
   reading, such as a guard against a hung process, needs no measurement. Rules out: exposing an
   internal threshold, such as the minimum sample length, "just in case"; a quick mode that shortens
   every run with no measurement behind it.

5. **Readable without the docs.** Names are the words a person would pick: `setup`, `teardown`,
   `median`. A printed result means something on its own. Rules out: abbreviated statistic names
   such as `aad`, `rme` or `period`; result objects whose fields exist only in some states.

6. **Isolated, and invisible to the user.** Each benchmark runs in a fresh process per engine, with
   only its own file loaded. In one test, ten benchmarks ran one after another in a shared process.
   Seven read slower than all twelve of their isolated runs, and one read 3.4 times its isolated
   median (Apple M2 Max, Node 26.13.0, Bun 1.4.4). repset starts those processes itself: the user
   writes no launcher script and no code that checks which process it runs in. Rules out: a
   shared-process mode; an API that asks for the user's `import.meta.url` so repset can re-run the
   user's script.

7. **Engines are peers.** The same benchmark file runs unchanged on every supported engine. A
   capability one engine lacks becomes a report field that is `null` on the engines without it,
   never core API. Benchmarks for code that cannot load on some engine, such as code that needs the
   DOM, go in a separate config file that lists their engines. They still use `bench()`. Rules out:
   `bun:jsc` or V8's `%` natives in the benchmark API; a Node-only option on a benchmark; an
   `engines` field on `bench()`.

8. **Diagnose loudly.** A body whose work the engine deleted fails its benchmark, and so does a
   missing garbage collector. A result is flagged when its warmup never settled, meaning its last
   five warmup samples did not agree within 5 % of their median. No suspect number passes in
   silence: a comparison between contenders carries a verdict or says it has none. Rules out: a
   warning-only default for the dead-code check; skipping the collection without a trace when `gc`
   is absent; a ratio column computed from one process per contender.

9. **The report records how it was measured.** The report records everything that changed the
   numbers: calls per sample, timer step, engine versions and the machine.

## Non-goals

- **Judging across revisions.** Baselines, history and whether an edit changed a number all need
  runs from several revisions. A comparison tool such as [gymrat][gymrat] owns them; repset's report
  is its input. repset judges only between the contenders of one benchmark, in one run.
- **Async and I/O benchmarks.** An awaited call cannot time like a plain loop (#1). Use mitata or
  tinybench for async code, and [hyperfine][hyperfine] for whole commands.
- **Profiling.** repset says how long a body takes, not why. Use the engine's profiler, such as
  [`node --cpu-prof`][cpu-prof].
- **Anything but steady state.** repset times a warmed-up body. First-call cost, frame timing, soak
  tests and device runs are telemetry: only a running app shows them. Use the engine's profiler or
  the app's own frame-time capture.

## Positioning

repset is the right choice for a TypeScript library or game engine whose synchronous hot paths run
on Node and Bun.

For a quick look, Deno.bench, mitata or `node:bench` answer faster, because they time every function
in one process. repset trades that speed for accuracy. Two processes running identical code can read
up to 25 % apart on one machine, so repset runs each contender in several fresh processes before it
calls one faster. repset is the wrong choice for async code and for whole programs, where hyperfine
fits.

Principles 2 to 5 keep the API small. [Luamark][luamark], a Lua benchmark library, covers its ground
with four measuring functions and two settings; tinybench needs six hooks on two levels, ten event
types, six result states and about fifteen options.

Borrowed:

- From [Luamark][luamark]: the API's restraint, wall-time budgets for `setupPerCall`, and the body's
  error winning over the teardown's.
- From [pmndrs/labs][pmndrs-labs]: the empty-body check and the settled flag.
- From [JMH][jmh] and [BenchmarkDotNet][benchmarkdotnet]: a fresh process per benchmark.

## Scope and maintenance

One maintainer. In scope: measuring the time and allocation of synchronous bodies, the runner that
gives each benchmark its own process, and the report. Work outside that scope ships as a separate
package that reads the report. The maintainer revisits the principles at each minor release.

[node]: https://nodejs.org/
[bun]: https://bun.com/
[mitata]: https://github.com/evanwashere/mitata
[tinybench]: https://github.com/tinylibs/tinybench
[deno-bench]: https://docs.deno.com/runtime/reference/cli/bench/
[node-bench]: https://nodejs.org/api/bench.html
[gymrat]: https://github.com/jeffzi/gymrat
[hyperfine]: https://github.com/sharkdp/hyperfine
[cpu-prof]: https://nodejs.org/api/cli.html#--cpu-prof
[luamark]: https://github.com/jeffzi/luamark
[pmndrs-labs]: https://github.com/pmndrs/labs
[jmh]: https://github.com/openjdk/jmh
[benchmarkdotnet]: https://github.com/dotnet/BenchmarkDotNet
