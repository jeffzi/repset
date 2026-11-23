# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `-d, --debug` (`debug` in the config and `run()`), which prints each failed case's stack and
  its process's output to stderr and keeps each measurement's `gc` in the report.

### Changed

- **Breaking:** Rename `--min-samples` and `minSamples` to `--min-sample-count` and
  `minSampleCount`, and `--rounds` and `rounds` to `--contest-repetition-count` and
  `contestRepetitionCount`; update your config files and scripts.
- **Breaking:** Move each result's `median` to `time.median` and its `processes[]` to
  `measurements[]`, whose entries hold a `time` block and rename `round` and `orderInRound` to
  `repetition` and `orderInRepetition`; update any script that reads the JSON report.
- **Breaking:** Rename the report's `machine` to `host`, `cores` to `coreCount`, `warmupSamples` and
  `timingAttempts` to `warmupSampleCount` and `timingAttemptCount`, each contest's `rounds` to
  `repetitionCount`, a contender's `median` to `time.median`, and the `tie` value `"rounds"` to
  `"repetitions"`.
- **Breaking:** Count only garbage collections in `gc`, under `collectionCount`, `durationMs`,
  `maxDurationMs`, `nodeMinorCollectionCount` and `nodeMajorCollectionCount`, and write it only with
  `--debug`.
- **Breaking:** Write `null` as a plain case's `repetition` and `orderInRepetition`, which have no
  meaning outside a contest.

## [0.3.0] - 2026-11-21

### Added

- Add contests: pass `bench()` a record of functions as `fn`, and repset runs them in a random order
  over rounds of fresh processes (`--rounds` or the `rounds` option), then ranks them and tells
  which it can prove faster.

### Changed

- Fill the report's `contests[]`, each result's `contender`, `options.rounds`, `options.seed` and
  each process's `round` and `orderInRound`, which 0.2.0 left empty, `null` or always 1.
- Refuse to run a benchmark file that loads repset 0.2 beside this version, instead of misreading
  its cases.

### Fixed

- Stop the run and exit 141 instead of crashing when stderr's reader closes early, as for stdout.
- Stop Node from reading a benchmark that walks its state up to twice as slow in some processes.

## [0.2.0] - 2026-11-19

### Added

- Add `--no-color` to print without color on a terminal.
- Show live progress on stderr when it is a terminal.
- Show defaults and usage examples in `--help`.
- Add `-o` for `--output` and `-h` for `--help`.
- Suggest the closest flag after an unknown one.
- Print a link to a prefilled GitHub issue when repset crashes.

### Changed

- Rename `--out` to `--output`.
- Read repeated flags, values that start with `-`, and `--version` beside `--help` as most
  command-line tools do.

### Removed

- Remove `--metric-lines`; read the JSON report from `--output -` instead.

### Fixed

- Write the final report and exit 129 on `SIGHUP`, as on `SIGINT` and `SIGTERM`.
- Name a bigint with its `n` suffix in error messages, so it no longer reads as a number.
- Stop the run and exit 141 instead of crashing when stdout's reader closes early.
- Report a benchmark that throws an unusual value, such as an error whose stack cannot be read, as
  failing with that value's message.

## [0.1.0] - 2026-11-17

### Added

- Add `bench()` to register a synchronous function as a benchmark case.
- Add the `repset` command, which measures each benchmark case in its own process on Node and Bun.
- Add `defineConfig` to type a repset config file.

[Unreleased]: https://github.com/jeffzi/repset/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jeffzi/repset/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/repset/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffzi/repset/releases/tag/v0.1.0
