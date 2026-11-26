/**
 * The diagnosis's header record: the machine and run it times on, and the options it times with.
 */
import type { BodyName } from "../check-timing-accuracy/bodies.js";
import type { Dependencies, Options, Spawner } from "../diagnose-bun-gap.js";

function trimmedOrNull(text: string | undefined): string | null {
  return text?.trim() ?? null;
}

/**
 * Reads the commit the diagnosis runs at.
 *
 * @param spawn - The spawner.
 * @returns The full hash of `HEAD`.
 * @throws Error when `git rev-parse HEAD` cannot start or fails.
 */
function headCommit(spawn: Spawner): string {
  const run = spawn("git", ["rev-parse", "HEAD"]);
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(
      `git rev-parse HEAD failed: ${run.error?.message ?? `status ${String(run.status)}`}`,
    );
  }
  return run.stdout.trim();
}

/**
 * Builds the header record: the machine, the run and the diagnosis's options.
 *
 * @param dependencies - The readers, the spawner and the environment.
 * @param options - The diagnosis's options.
 * @param sampleCounts - The sample count each body's baseline and variant children run at.
 * @returns The header record.
 * @throws Error when the commit cannot be read.
 */
export function headerRecord(
  dependencies: Dependencies,
  options: Options,
  sampleCounts: Readonly<Record<BodyName, number>>,
): Record<string, unknown> {
  const { readers, environment } = dependencies;
  const cpuinfo = readers.file("/proc/cpuinfo") ?? "";
  return {
    kind: "header",
    cpuModel: /^model name\s*:(.*)$/mu.exec(cpuinfo)?.[1]?.trim() ?? null,
    cpuCount: environment.cpuCount,
    kernel: environment.kernel,
    sysVendor: trimmedOrNull(readers.file("/sys/class/dmi/id/sys_vendor")),
    productName: trimmedOrNull(readers.file("/sys/class/dmi/id/product_name")),
    bunVersion: environment.bun.version,
    nodeVersion: environment.nodeVersion,
    commit: headCommit(dependencies.spawn),
    runId: environment.variables["GITHUB_RUN_ID"] ?? null,
    runAttempt: environment.variables["GITHUB_RUN_ATTEMPT"] ?? null,
    pinned: options.pin,
    cyclesPerBody: options.cyclesPerBody,
    sides: options.sides,
    sampleCounts,
  };
}
