# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add color to the table, error lines, `--once` results and `--help` on a terminal, decided per
  stream.
- Add `--no-color` to turn color off on every stream.
- Add a live progress line on a terminal stderr, counting the children of each phase.
- Add examples and a link to the README to `--help`, and suggest the closest flag after an unknown
  one.
- Add the version, the platform and a link to a prefilled GitHub issue to the output of a crash.

### Changed

- Draw the table with column rules and separators, its rows flush with the runtime heading.
- Take the last value of a flag given twice instead of rejecting it.
- Print the version, not the help, when `--version` and `--help` are both given.
- Fail a value flag given last with no value before printing `--help`.
- Take a value that starts with `-` as a flag's value: `--filter --list` filters on `--list`.
- Reword the messages of command-line errors.

### Fixed

- Write the final report and exit 129 on `SIGHUP`, as on `SIGINT` and `SIGTERM`.

## [0.1.0] - 2026-11-17

### Added

- Add `bench()` to register a synchronous function as a benchmark case.
- Add the `repset` command, which measures each benchmark case in its own process on Node and Bun.
- Add `defineConfig` to type a repset config file.

[Unreleased]: https://github.com/jeffzi/repset/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeffzi/repset/releases/tag/v0.1.0
