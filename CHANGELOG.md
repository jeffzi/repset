# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `--no-color` to print without color on a terminal.
- Show live progress on stderr when it is a terminal.
- Show each option's default, examples and a link to the README in `--help`.
- Add `-o` for `--output` and `-h` for `--help`.
- Suggest the closest flag after an unknown one.
- Add the version, the platform and a link to a prefilled GitHub issue to the output of a crash.

### Changed

- Rename `--out` to `--output`.
- Read flags as most command-line tools do: a repeated flag takes its last value, a flag's value may
  start with `-`, and `--version` wins over `--help`.

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

[Unreleased]: https://github.com/jeffzi/repset/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeffzi/repset/releases/tag/v0.1.0
