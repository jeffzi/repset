/**
 * The Bun gap diagnosis: on Bun only, it times each body of the timing accuracy check at one call
 * per sample with repset, with the check's baseline child, with every baseline variant of
 * `diagnose-bun-gap/variant-child.ts`, with the check's baseline case run through repset's child
 * entry, with the baseline children of `diagnose-bun-gap/` that each add one piece of repset's
 * child, with the baseline child under a Node parent, and with repset's child started directly, and
 * appends one JSON line per process to the `--out` file.
 *
 *   node --import tsx scripts/diagnose-bun-gap.ts --out <file> [--cycles <n>] [--sides <list>]
 *     [--pin] [--job <n>]
 *
 * `--job` is the index of the CI matrix job the run belongs to, which the header records.
 *
 * Run it from the repository root, as the Taskfile does: every path it hands a child is relative to
 * the current directory, except repset's child entry and the bench file its requests name, which
 * are absolute because the child reads absolute paths only. It reads `dist/`, so build first.
 * Nothing in it runs two children at once: the diagnosis is a measurement, and a second process
 * would move every reading.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ChildRequest, MeasureRequest } from "../src/child-protocol.js";
import { isFailed, readResult, type ResultByMode } from "../src/child-result.js";
import { childRuntimeFlags, howItEnded } from "../src/children.js";
import { DEFAULT_MIN_SAMPLES, DEFAULT_MIN_TIME } from "../src/measure/measure.js";
import { property, thrownMessage, valueAt } from "../src/utils.js";
import { baselineMedian, baselineSpawn } from "./check-timing-accuracy.js";
import { BODY_NAMES, type BodyName, benchName } from "./check-timing-accuracy/bodies.js";
import { headerRecord } from "./diagnose-bun-gap/header.js";
import { liveDependencies } from "./diagnose-bun-gap/live-dependencies.js";
import { VARIANTS } from "./diagnose-bun-gap/variants.js";

/** How one child process ended and what it printed on stdout. */
export interface ChildRun {
  /** Set when the process could not start. */
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  /** What the child wrote on file descriptor 3, when the spawn asked for it. */
  readonly result?: string | undefined;
  /** What the child wrote on stderr, when the spawn asked for its result. */
  readonly stderr?: string | undefined;
}

/** How a spawn sets up the child's descriptors and environment. */
export interface SpawnOptions {
  /**
   * Whether the child gets a pipe on file descriptor 3, read into `result`, and
   * one on stderr, read into `stderr`.
   */
  readonly result: boolean;
  /** The child's environment; the driver's own when absent. */
  readonly env?: NodeJS.ProcessEnv | undefined;
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
  /** The index of the CI matrix job the run belongs to; `null` outside a matrix. */
  readonly job: number | null;
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
  "child-baseline",
  "child-baseline-again",
  ...BASELINE_PIECES,
  "baseline-under-parent",
  "repset-child-direct",
] as const;

type Side = (typeof SIDES)[number];

const SIDE_NAMES: ReadonlySet<string> = new Set(SIDES);
const PIECE_NAMES: ReadonlySet<string> = new Set(BASELINE_PIECES);

const DEFAULT_CYCLES = 170;

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
 * Reads the `--job` matrix index.
 *
 * @param value - The flag's value, or `undefined` when it is absent.
 * @returns The index, or `null` when the flag is absent.
 * @throws Error naming the value when it is not a non-negative integer.
 */
function jobOption(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`bad --job '${value}': expected a non-negative integer`);
  }
  return Number(value);
}

/**
 * Validates the flags and rounds the cycle count so that every side holds every position equally
 * often.
 *
 * @param argv - The arguments after the script path.
 * @returns The options, with the cycles per body rounded up to a multiple of the number of sides,
 *   so each side holds each position equally often.
 * @throws Error when `--out` is missing, `--cycles` is not a positive integer, `--job` is not a
 *   non-negative integer, `--sides` names an unknown side or none, or an argument is not an option
 *   this script takes.
 */
function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      cycles: { type: "string" },
      sides: { type: "string" },
      out: { type: "string" },
      pin: { type: "boolean" },
      job: { type: "string" },
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
    job: jobOption(values.job),
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

/** Starts the bun executable on `args`, after the flags repset's own children start with. */
function spawnOnBun(
  dependencies: Dependencies,
  args: readonly string[],
  options?: SpawnOptions,
): ChildRun {
  return dependencies.spawn(
    dependencies.environment.bun.executable,
    [...childRuntimeFlags("bun", undefined), ...args],
    options,
  );
}

/**
 * Starts repset's child entry on Bun with `request`, as repset's parent starts it, with a pipe for
 * the result on file descriptor 3.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param request - What the child is asked to do.
 * @param env - The child's environment; the driver's own when absent.
 * @returns The run of a child that started.
 * @throws Error when the child could not start.
 */
function spawnChildEntry(
  dependencies: Dependencies,
  request: ChildRequest,
  env?: NodeJS.ProcessEnv,
): ChildRun {
  const run = spawnOnBun(dependencies, [CHILD_ENTRY, JSON.stringify(request)], {
    result: true,
    env,
  });
  assertStarted(run);
  return run;
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
  return childOutput(spawnOnBun(dependencies, [script, ...args]));
}

/**
 * Starts repset's child entry on Bun with `request`, as repset's parent starts it, and reads the
 * result it writes on file descriptor 3.
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
  const run = spawnChildEntry(dependencies, request);
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

/**
 * Times `body`'s baseline case at one call per sample through repset's child entry on Bun, as the
 * timing accuracy check reads its baseline.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param body - The body whose baseline case to run.
 * @param sampleCount - The sample count to run the case at.
 * @returns The median the case printed, in nanoseconds per call.
 * @throws Error when the child could not start, or as {@link baselineMedian} says.
 */
function readChildBaseline(
  dependencies: Dependencies,
  body: BodyName,
  sampleCount: number,
): number {
  const { request, env } = baselineSpawn(body, { callsPerSample: 1, sampleCount });
  const run = spawnChildEntry(dependencies, request, env);
  return baselineMedian("repset's child entry", {
    status: run.status,
    signal: run.signal ?? null,
    written: run.result ?? "",
    stdout: run.stdout,
    stderr: run.stderr ?? "",
  });
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
  if (side === "child-baseline" || side === "child-baseline-again") {
    const median = readChildBaseline(dependencies, body, sampleCount);
    return { median, sampleCount, ...NOT_REPORTED };
  }
  return readScriptSide(dependencies, side, [body, "1", String(sampleCount)], sampleCount);
}

/**
 * Starts the side's own script on Bun — the baseline child (`baseline-child.ts`), a baseline piece or the variant
 * child — or the baseline child under a Node parent, and turns what it prints into one reading's
 * fields.
 *
 * @param dependencies - The spawner and the bun executable.
 * @param side - The side to read: one that starts a script of its own.
 * @param args - The body, the calls per sample and the sample count, as the scripts take them.
 * @param sampleCount - The sample count the script runs at.
 * @returns What the script reported, with `null` for what its side does not report.
 * @throws Error when the child fails as {@link childOutput} says or prints a field of the wrong
 *   type.
 */
function readScriptSide(
  dependencies: Dependencies,
  side: Side,
  args: readonly string[],
  sampleCount: number,
): Measured {
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

if (import.meta.main) {
  runDiagnosis(process.argv.slice(2), await liveDependencies());
}
