/**
 * The Bun gap diagnosis: on Bun only, it times each body of the timing accuracy check at one call
 * per sample with repset, with the check's baseline child, with every baseline variant of
 * `diagnose-bun-gap/variant-child.ts`, with the baseline children of `diagnose-bun-gap/` that each
 * add one piece of repset's child, with the baseline child under a Node parent, and with repset's
 * child started directly, and appends one JSON line per process to the `--out` file.
 *
 *   node --import tsx scripts/diagnose-bun-gap.ts --out <file> [--cycles <n>] [--sides <list>]
 *     [--pin]
 *
 * Run it from the repository root, as the Taskfile does: every path it hands a child is relative to
 * the current directory, except repset's child entry and the bench file its requests name, which
 * are absolute because the child reads absolute paths only. It reads `dist/`, so build first.
 * Nothing in it runs two children at once: the diagnosis is a measurement, and a second process
 * would move every reading.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ChildRequest, MeasureRequest } from "../src/child-protocol.js";
import { isFailed, readResult, type ResultByMode } from "../src/child-result.js";
import { childRuntimeFlags, findRuntime, howItEnded } from "../src/children.js";
import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "../src/measure/measure.js";
import { DEFAULT_TIMEOUT } from "../src/options.js";
import { RESULT_FD } from "../src/result-fd.js";
import { property, thrownMessage, valueAt } from "../src/utils.js";
import { readRepsetRun } from "./check-timing-accuracy.js";
import { BODY_NAMES, type BodyName, benchName } from "./check-timing-accuracy/bodies.js";
import { headerRecord } from "./diagnose-bun-gap/header.js";
import { VARIANTS } from "./diagnose-bun-gap/variants.js";

/** How one child process ended and what it printed on stdout. */
export interface ChildRun {
  /** Set when the process could not start. */
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  /** What the child wrote on file descriptor {@link RESULT_FD}, when the spawn asked for it. */
  readonly result?: string | undefined;
}

/** How a spawn sets up the child's descriptors. */
interface SpawnOptions {
  /** Whether the child gets a pipe on file descriptor {@link RESULT_FD}, read into `result`. */
  readonly result: boolean;
}

/** Runs `command` with `args` to its end, one process at a time. */
export type Spawner = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildRun;

/** What one repset run reports about its one process. */
export interface RepsetSample {
  /** Nanoseconds per call. */
  readonly median: number;
  readonly sampleCount: number;
}

/** What the diagnosis reads outside its child processes. */
export interface Readers {
  /** Runs repset once on Bun, at one call per sample, on `body`. */
  readonly repset: (body: BodyName) => RepsetSample;
  /** Returns the text of the file at a path, or `undefined` when it cannot be read. */
  readonly file: (path: string) => string | undefined;
}

/** The machine and process the diagnosis runs in. */
export interface Environment {
  /** The executable the baseline, variant and repset children start on, and its version. */
  readonly bun: { readonly executable: string; readonly version: string };
  readonly variables: Readonly<Record<string, string | undefined>>;
  /** The driver's own process id, which pinning applies to. */
  readonly pid: number;
  readonly cpuCount: number;
  readonly kernel: string;
  readonly nodeVersion: string;
  readonly now: () => Date;
}

/** Everything {@link runDiagnosis} reads, starts and writes through. */
export interface Dependencies {
  readonly readers: Readers;
  readonly spawn: Spawner;
  /** Appends without truncating, once per record, so a stopped run keeps every finished record. */
  readonly append: (path: string, text: string) => void;
  readonly environment: Environment;
}

/** What one process reports, as a reading record carries it. */
interface Measured {
  readonly median: number;
  readonly sampleCount: number;
  readonly firstHalfMedian: number | null;
  readonly secondHalfMedian: number | null;
  readonly p75: number | null;
  readonly p99: number | null;
  readonly cpuStart: number | null;
  readonly cpuEnd: number | null;
}

/** The diagnosis's options, from its flags. */
export interface Options {
  readonly cyclesPerBody: number;
  readonly sides: readonly Side[];
  readonly out: string;
  readonly pin: boolean;
}

/** The baseline children of `diagnose-bun-gap/`, each the baseline child plus one piece. */
const BASELINE_PIECES = [
  "baseline-args",
  "baseline-async",
  "baseline-table",
  "baseline-proc",
  "baseline-with-variants",
  "baseline-child-modules",
] as const;

type BaselinePiece = (typeof BASELINE_PIECES)[number];

const SIDES = [
  "repset",
  "baseline",
  ...VARIANTS,
  "baseline-again",
  ...BASELINE_PIECES,
  "baseline-under-parent",
  "repset-child-direct",
] as const;

type Side = (typeof SIDES)[number];

const SIDE_NAMES: ReadonlySet<string> = new Set(SIDES);
const PIECE_NAMES: ReadonlySet<string> = new Set(BASELINE_PIECES);

const DEFAULT_CYCLES = 170;

const BENCH_FILE = join("scripts", "check-timing-accuracy", "timing-accuracy.bench.ts");
const DIAGNOSE_DIR = join("scripts", "diagnose-bun-gap");
const BASELINE_CHILD = join(DIAGNOSE_DIR, "baseline-child.ts");
const VARIANT_CHILD = join(DIAGNOSE_DIR, "variant-child.ts");
const NODE_PARENT = join(DIAGNOSE_DIR, "node-parent.ts");
// Repset's child reads absolute paths only: its request names an absolute `file`.
const CHILD_ENTRY = fileURLToPath(new URL("../dist/child.js", import.meta.url));
const ABSOLUTE_BENCH_FILE = fileURLToPath(
  new URL("check-timing-accuracy/timing-accuracy.bench.ts", import.meta.url),
);

/**
 * The reading fields a side leaves null unless its child reports them: the variant children report
 * all six, `baseline-proc` only `cpuStart` and `cpuEnd`.
 */
const NOT_REPORTED = {
  firstHalfMedian: null,
  secondHalfMedian: null,
  p75: null,
  p99: null,
  cpuStart: null,
  cpuEnd: null,
} as const;

function isSide(name: string): name is Side {
  return SIDE_NAMES.has(name);
}

function isBaselinePiece(side: Side): side is BaselinePiece {
  return PIECE_NAMES.has(side);
}

/**
 * Picks the sides a `--sides` list names, in the default side order.
 *
 * @param list - The comma-separated side names.
 * @returns The named sides.
 * @throws Error naming the first name that is not a side, or when the list names none.
 */
function pickSides(list: string): Side[] {
  const names = list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.find((name) => !isSide(name));
  if (unknown !== undefined) {
    throw new Error(`unknown side '${unknown}': expected ${SIDES.join(", ")}`);
  }
  const picked = SIDES.filter((side) => names.includes(side));
  if (picked.length === 0) throw new Error("--sides names no side");
  return picked;
}

/**
 * Validates the flags and rounds the cycle count so that every side holds every position equally
 * often.
 *
 * @param argv - The arguments after the script path.
 * @returns The options, with the cycles per body rounded up to a multiple of the number of sides,
 *   so each side holds each position equally often.
 * @throws Error when `--out` is missing, `--cycles` is not a positive integer, `--sides` names an
 *   unknown side or none, or an argument is not an option this script takes.
 */
function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      cycles: { type: "string" },
      sides: { type: "string" },
      out: { type: "string" },
      pin: { type: "boolean" },
    },
    strict: true,
  });
  if (values.out === undefined) throw new Error("--out <file> is required");
  const sides = values.sides === undefined ? SIDES : pickSides(values.sides);
  const cycles = values.cycles === undefined ? DEFAULT_CYCLES : Number(values.cycles);
  if (!Number.isSafeInteger(cycles) || cycles < 1) {
    throw new Error(`bad --cycles '${String(values.cycles)}': expected a positive integer`);
  }
  return {
    cyclesPerBody: Math.ceil(cycles / sides.length) * sides.length,
    sides,
    out: values.out,
    pin: values.pin ?? false,
  };
}

/**
 * Runs `read`, prefixing what it throws with `label`.
 *
 * @param label - What `read` reads, which the error names first.
 * @param read - The read to run.
 * @returns What `read` returns.
 * @throws Error starting with `label`, whose cause is what `read` threw.
 */
function labeled<T>(label: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Error(`${label}: ${thrownMessage(error)}`, { cause: error });
  }
}

function exitOf(subject: string, run: ChildRun): string {
  return howItEnded(subject, { kind: "exit", code: run.status, signal: run.signal ?? null });
}

/** Throws when the child process could not start. */
function assertStarted(run: ChildRun): void {
  if (run.error !== undefined) {
    throw new Error(`cannot start the child: ${run.error.message}`, { cause: run.error });
  }
}

/**
 * Checks one child run and parses its last stdout line.
 *
 * @param run - The child's run.
 * @returns The parsed line, which holds a finite numeric `median`.
 * @throws Error when the child could not start, ended otherwise than with status 0, or printed no
 *   JSON line holding a finite median.
 */
function childOutput(run: ChildRun): unknown {
  assertStarted(run);
  if (run.status !== 0) {
    throw new Error(exitOf("the child", run));
  }
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  let printed: unknown;
  try {
    printed = JSON.parse(line);
  } catch {
    printed = undefined;
  }
  const median = property(printed, "median");
  if (typeof median !== "number" || !Number.isFinite(median)) {
    throw new Error("the child printed no finite median");
  }
  return printed;
}

function numberField(printed: unknown, key: string): number {
  const value = property(printed, key);
  if (typeof value !== "number") throw new Error(`the child printed no numeric ${key}`);
  return value;
}

function nullableField(printed: unknown, key: string): number | null {
  return property(printed, key) === null ? null : numberField(printed, key);
}

/**
 * Starts one bun child on `script` with `args`, with the flags repset's own children start with.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param script - The child script's path.
 * @param args - The arguments after the script path.
 * @returns The child's parsed output line.
 * @throws Error when the child fails as {@link childOutput} says.
 */
function runBunChild(dependencies: Dependencies, script: string, args: readonly string[]): unknown {
  const flags = childRuntimeFlags("bun", undefined);
  return childOutput(
    dependencies.spawn(dependencies.environment.bun.executable, [...flags, script, ...args]),
  );
}

/**
 * Starts repset's child entry on Bun with `request`, as repset's parent starts it, and reads the
 * result it writes on file descriptor {@link RESULT_FD}.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param request - What the child is asked to do.
 * @returns The result the child wrote.
 * @throws Error when the child could not start, wrote no result or one that does not answer
 *   `request`, or wrote a failed result.
 */
function runRepsetChild<R extends ChildRequest>(
  dependencies: Dependencies,
  request: R,
): ResultByMode[R["mode"]] {
  const run = dependencies.spawn(
    dependencies.environment.bun.executable,
    [...childRuntimeFlags("bun", undefined), CHILD_ENTRY, JSON.stringify(request)],
    { result: true },
  );
  assertStarted(run);
  const read = readResult(run.result ?? "", request);
  if (typeof read === "string") throw new Error(`${exitOf("the child", run)}: ${read}`);
  if (isFailed(read)) {
    throw new Error(`the child failed in phase ${read.error.phase}: ${read.error.message}`);
  }
  return read;
}

/**
 * Lists the bench file's cases through repset's child and picks the one the repset side times.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param body - The body whose case to pick.
 * @returns The id of the one listed case named as the repset side filters `body`.
 * @throws Error when the list request fails as {@link runRepsetChild} says, or lists no case or
 *   more than one by that name.
 */
function listedCaseId(dependencies: Dependencies, body: BodyName): string {
  const name = benchName(body);
  const listed = runRepsetChild(dependencies, { mode: "list", file: ABSOLUTE_BENCH_FILE });
  const matches = listed.cases.filter((listedCase) => listedCase.name === name);
  const [only] = matches;
  if (only === undefined || matches.length > 1) {
    throw new Error(`the bench file lists ${matches.length} cases named '${name}', not one`);
  }
  return only.id;
}

/**
 * Times one case at one call per sample through repset's child, started directly.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param id - The case's id, as the list request gave it.
 * @returns The median and sample count the child measured.
 * @throws Error when the child fails as {@link runRepsetChild} says, or its timing holds no finite
 *   median.
 */
function readRepsetChild(dependencies: Dependencies, id: string): Measured {
  const request: MeasureRequest = {
    mode: "measure",
    file: ABSOLUTE_BENCH_FILE,
    id,
    minTime: DEFAULT_MIN_TIME,
    minSamples: DEFAULT_MIN_SAMPLES,
    callsPerSample: 1,
    time: true,
    memory: false,
  };
  const stats = runRepsetChild(dependencies, request).time?.stats;
  if (stats === undefined || !Number.isFinite(stats.median)) {
    throw new Error("the child wrote no finite median");
  }
  return { median: stats.median, sampleCount: stats.sampleCount, ...NOT_REPORTED };
}

/** What every reading of one body shares, fixed before the first cycle. */
interface BodySetup {
  /** The sample count baseline and variant children run at. */
  readonly sampleCount: number;
  /** The id of the body's case, which repset-child-direct measures; `undefined` when it does not run. */
  readonly caseId: string | undefined;
}

/**
 * Starts the side's process, or calls the repset reader, and turns what it reports into one
 * reading's fields.
 *
 * @param dependencies - The readers and the spawner.
 * @param side - The side to read.
 * @param body - The body to time.
 * @param setup - The body's fixed sample count and listed case id.
 * @returns What the process reported, with `null` for what its side does not report.
 * @throws Whatever the repset reader throws, or an Error when a child fails or repset-child-direct
 *   runs without a listed case id.
 */
function readSide(
  dependencies: Dependencies,
  side: Side,
  body: BodyName,
  setup: BodySetup,
): Measured {
  const { sampleCount } = setup;
  if (side === "repset") {
    const reading = dependencies.readers.repset(body);
    return { median: reading.median, sampleCount: reading.sampleCount, ...NOT_REPORTED };
  }
  if (side === "repset-child-direct") {
    if (setup.caseId === undefined) throw new Error("no case id was listed for the body");
    return readRepsetChild(dependencies, setup.caseId);
  }
  const args = [body, "1", String(sampleCount)];
  if (side === "baseline" || side === "baseline-again") {
    const printed = runBunChild(dependencies, BASELINE_CHILD, args);
    return { median: numberField(printed, "median"), sampleCount, ...NOT_REPORTED };
  }
  if (side === "baseline-under-parent") {
    const run = dependencies.spawn(process.execPath, [NODE_PARENT, BASELINE_CHILD, ...args]);
    return { median: numberField(childOutput(run), "median"), sampleCount, ...NOT_REPORTED };
  }
  if (isBaselinePiece(side)) {
    const printed = runBunChild(dependencies, join(DIAGNOSE_DIR, `${side}.ts`), args);
    const cpus =
      side === "baseline-proc"
        ? { cpuStart: nullableField(printed, "cpuStart"), cpuEnd: nullableField(printed, "cpuEnd") }
        : {};
    return { median: numberField(printed, "median"), sampleCount, ...NOT_REPORTED, ...cpus };
  }
  const printed = runBunChild(dependencies, VARIANT_CHILD, [side, ...args]);
  return {
    median: numberField(printed, "median"),
    sampleCount: numberField(printed, "sampleCount"),
    firstHalfMedian: nullableField(printed, "firstHalfMedian"),
    secondHalfMedian: nullableField(printed, "secondHalfMedian"),
    p75: nullableField(printed, "p75"),
    p99: nullableField(printed, "p99"),
    cpuStart: nullableField(printed, "cpuStart"),
    cpuEnd: nullableField(printed, "cpuEnd"),
  };
}

/**
 * Pins the driver to `cpu`, so every child it starts afterwards inherits that affinity.
 *
 * @param dependencies - The spawner and the driver's process id.
 * @param cpu - The CPU to pin to.
 * @returns `cpu`.
 * @throws Error naming the CPU when `taskset` cannot start or fails.
 */
function pinTo(dependencies: Dependencies, cpu: number): number {
  const run = dependencies.spawn("taskset", [
    "-cp",
    String(cpu),
    String(dependencies.environment.pid),
  ]);
  if (run.error !== undefined) {
    throw new Error(`cannot pin the driver to CPU ${cpu}: ${run.error.message}`, {
      cause: run.error,
    });
  }
  if (run.status !== 0) {
    throw new Error(`cannot pin the driver to CPU ${cpu}: ${exitOf("taskset", run)}`);
  }
  return cpu;
}

/**
 * Appends a header record, then one reading record per side, body and cycle, to the `--out` file.
 *
 * Before the first cycle, one unrecorded repset reading per body fixes the sample count that
 * body's baseline and variant children run at, and when repset-child-direct runs, one list request
 * per body picks the case it measures. Cycle `k` of each body runs the sides rotated left
 * by `k`, so each side holds each position equally often, and the bodies alternate cycle by cycle.
 * With `--pin`, the driver pins itself to CPU `k mod cpuCount` before cycle `k` of each body.
 *
 * @param argv - The arguments after the script path.
 * @param dependencies - What the diagnosis reads, starts and writes through.
 * @throws Error when the arguments are bad (see {@link parseOptions}).
 * @throws Error naming the side, body and cycle when a process fails, or the side, body and `list`
 *   when a list request fails; the records appended before it stay in the file.
 * @throws Error naming the CPU when pinning fails, or when the commit cannot be read.
 * @throws Whatever `append` throws.
 */
export function runDiagnosis(argv: readonly string[], dependencies: Dependencies): void {
  const options = parseOptions(argv);
  const { environment } = dependencies;
  const write = (record: Record<string, unknown>): void => {
    dependencies.append(options.out, `${JSON.stringify(record)}\n`);
  };
  const fixedCount = (body: BodyName): number =>
    labeled(`repset ${body}, the unrecorded reading`, () => dependencies.readers.repset(body))
      .sampleCount;
  const sampleCounts = { each: fixedCount("each"), inlined: fixedCount("inlined") };
  const caseId = (body: BodyName): string | undefined =>
    options.sides.includes("repset-child-direct")
      ? labeled(`repset-child-direct ${body} list`, () => listedCaseId(dependencies, body))
      : undefined;
  const caseIds = { each: caseId("each"), inlined: caseId("inlined") };
  write(headerRecord(dependencies, options, sampleCounts));
  const sideCount = options.sides.length;
  for (let cycle = 0; cycle < options.cyclesPerBody; cycle += 1) {
    for (const body of BODY_NAMES) {
      const pinnedCpu = options.pin ? pinTo(dependencies, cycle % environment.cpuCount) : null;
      for (let position = 0; position < sideCount; position += 1) {
        const side = valueAt(options.sides, (cycle + position) % sideCount);
        const measured = labeled(`${side} ${body} cycle ${cycle}`, () =>
          readSide(dependencies, side, body, {
            sampleCount: sampleCounts[body],
            caseId: caseIds[body],
          }),
        );
        const time = environment.now().toISOString();
        write({ kind: "reading", cycle, position, body, side, ...measured, pinnedCpu, time });
      }
    }
  }
}

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
    stdio: withResult ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  });
  return {
    error: run.error,
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    result: withResult ? (run.output[RESULT_FD] ?? "") : undefined,
  };
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const bun = await findRuntime("bun", { timeout: DEFAULT_TIMEOUT });
  runDiagnosis(process.argv.slice(2), {
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
  });
}
