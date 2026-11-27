/**
 * The Bun gap diagnosis's live dependencies: the real repset reader, spawner, file reader and
 * appender, and the machine the driver runs on.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, release } from "node:os";
import { join } from "node:path";

import { findRuntime } from "../../src/children.js";
import { DEFAULT_TIMEOUT } from "../../src/options.js";
import { RESULT_FD } from "../../src/result-fd.js";
import { readRepsetRun } from "../check-timing-accuracy.js";
import { type BodyName, benchName } from "../check-timing-accuracy/bodies.js";
import type { ChildRun, Dependencies, RepsetSample, SpawnOptions } from "../diagnose-bun-gap.js";

const BENCH_FILE = join("scripts", "check-timing-accuracy", "timing-accuracy.bench.ts");

/**
 * Runs repset once on Bun on `body`, with its count fixed at one call per sample.
 *
 * @param body - The body to time.
 * @returns The run's median and sample count.
 * @throws Error naming the body when the run fails or its count is not fixed at 1.
 */
function readRepsetOnBun(body: BodyName): RepsetSample {
  const name = `repset ${body}`;
  return readRepsetRun(
    name,
    [BENCH_FILE, "--runtime", "bun", "--filter", `^${benchName(body)}$`],
    (_result, sampling) => {
      if (!sampling.callsPerSampleFixed || sampling.callsPerSample !== 1) {
        const reported = `${String(sampling.callsPerSample)} ${sampling.callsPerSampleFixed ? "fixed" : "calibrated"}`;
        throw new Error(`${name}: expected a count fixed at 1, the process reports ${reported}`);
      }
    },
    1,
  );
}

function spawnText(command: string, args: readonly string[], options?: SpawnOptions): ChildRun {
  const withResult = options?.result === true;
  const run = spawnSync(command, args, {
    encoding: "utf8",
    env: options?.env,
    stdio: withResult ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  });
  return {
    error: run.error,
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    result: withResult ? (run.output[RESULT_FD] ?? "") : undefined,
    stderr: withResult ? run.stderr : undefined,
  };
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Finds Bun and gathers the live dependencies the driver runs with.
 *
 * @returns The real readers, spawner and appender, and this process's machine and environment.
 * @throws The `ConfigError` `findRuntime` throws when Bun is not on `PATH` or its version probe
 *   fails or runs past the default timeout.
 */
export async function liveDependencies(): Promise<Dependencies> {
  const bun = await findRuntime("bun", { timeout: DEFAULT_TIMEOUT });
  return {
    readers: { repset: readRepsetOnBun, file: readOptionalFile },
    spawn: spawnText,
    append: (path, text) => {
      appendFileSync(path, text);
    },
    environment: {
      bun: { executable: bun.executable, version: bun.version },
      variables: process.env,
      pid: process.pid,
      cpuCount: availableParallelism(),
      kernel: release(),
      nodeVersion: process.versions.node,
      now: () => new Date(),
    },
  };
}
