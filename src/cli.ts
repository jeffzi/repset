#!/usr/bin/env node
import { release } from "node:os";

import { crashReport, main, streamColors } from "./command.js";
import { packageVersion } from "./run.js";

const args = process.argv.slice(2);
try {
  process.exitCode = await main(args);
} catch (error) {
  // The crash report names the version as unknown rather than replace the crash with this failure.
  const version = await packageVersion().catch(() => undefined);
  const report = crashReport(error, {
    version,
    os: `${process.platform} ${release()} ${process.arch}`,
    runtime: `node ${process.versions.node}`,
    color: streamColors(args, process.stdout, process.stderr).stderr,
  });
  process.stderr.write(report);
  // The code Node exits with on an uncaught error.
  process.exitCode = 1;
}
