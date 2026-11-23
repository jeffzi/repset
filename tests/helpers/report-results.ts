import type { ChildPhase } from "../../src/child-protocol.js";
import type { StrictOmit } from "../../src/command-line.js";
import type {
  Contest,
  ContestContender,
  FailedResult,
  HeadlineMemory,
  MeasuredResult,
  Result,
  ResultError,
} from "../../src/report.js";
import { formatTable } from "../../src/table.js";
import { measured as measuredChild, memoryOf, runtimeOf } from "./fake-children.js";

export type Runtime = Result["runtime"]["name"];
type Measurement = MeasuredResult["measurements"][number];
export type Stats = NonNullable<Measurement["time"]>["stats"];
type ResultBase = StrictOmit<Result, "status" | "error" | "time" | "memory" | "measurements">;

/** The statistics of a case whose every time is `median`, measured over 64 samples. */
export function flatStats(median: number): Stats {
  return {
    min: median,
    p25: median,
    median,
    p75: median,
    p99: median,
    max: median,
    mean: median,
    sampleCount: 64,
  };
}

/** The one measurement of a measured plain case, timed with `stats` (none when null) and reading `memory`. */
function measurement(stats: Stats | null, memory: HeadlineMemory | null): Measurement {
  return {
    repetition: null,
    orderInRepetition: null,
    time: stats === null ? null : { ...measuredChild(stats.median).time, stats, gc: null },
    memory: memory === null ? null : memoryOf(memory.median),
  };
}

/** What every result of case `id` on `runtime` holds, measured or failed. */
function resultBase(id: string, runtime: Runtime): ResultBase {
  return {
    id,
    name: id,
    contender: null,
    params: {},
    file: "fruit.bench.ts",
    runtime: runtimeOf(runtime),
    setupPerCall: false,
  };
}

/** A result of case `id` measured on `runtime` with `stats` (no time when null) and the memory reading `memory`. */
export function measured(
  id: string,
  runtime: Runtime,
  stats: Stats | null,
  memory: HeadlineMemory | null = null,
): MeasuredResult {
  return {
    ...resultBase(id, runtime),
    status: "ok",
    error: null,
    time: stats === null ? null : { unit: "ns/call", median: stats.median },
    memory,
    measurements: [measurement(stats, memory)],
  };
}

/** A result of case `id` on Node that failed in `phase` with `message`, its cleanup teardown `teardownError`. */
export function failed(
  id: string,
  phase: ChildPhase,
  message: string,
  teardownError: ResultError["teardownError"] = null,
): FailedResult {
  return {
    ...resultBase(id, "node"),
    status: "failed",
    error: { phase, message, stack: null, teardownError, output: "" },
    time: null,
    memory: null,
    measurements: [{ repetition: null, orderInRepetition: null, time: null, memory: null }],
  };
}

/** A result of contender `key` of contest `name` with every time `median` (none when null), on Node and reading no memory unless told otherwise. */
export function contenderResult(
  name: string,
  key: string,
  median: number | null,
  { runtime = "node", memory = null }: { runtime?: Runtime; memory?: HeadlineMemory | null } = {},
): MeasuredResult {
  const stats = median === null ? null : flatStats(median);
  return { ...measured(`${name}/${key}`, runtime, stats, memory), name, contender: key };
}

/** Contender `id` of a contest entry, with its median, and its ratio and rank once judged (null otherwise). */
export function contender(
  id: string,
  median: number | null,
  ratio: number | null = null,
  rank: number | null = null,
): ContestContender {
  return {
    id,
    time: median === null ? null : { unit: "ns/call", median },
    memory: null,
    ratio,
    rank,
  };
}

/** The entry of contest `name` on Node over `repetitionCount` repetitions. */
export function contest(
  name: string,
  repetitionCount: number,
  contenders: readonly ContestContender[],
  pairs: Contest["pairs"],
): Contest {
  return {
    name,
    params: {},
    runtime: runtimeOf("node"),
    repetitionCount,
    contenders,
    pairs,
  };
}

/** The lines of the table of `results` and `contests`, uncolored unless `options` says, the last one empty after the closing newline. */
export function tableLines(
  results: readonly Result[],
  contests: readonly Contest[] = [],
  options: Partial<Parameters<typeof formatTable>[2]> = {},
): string[] {
  return formatTable(results, contests, { color: false, ...options }).split("\n");
}

/** The index of the first line that starts with `id` and a space, or -1 when no row does. */
export function rowIndex(lines: readonly string[], id: string): number {
  return lines.findIndex((line) => line.startsWith(`${id} `));
}

/** The trimmed cells of `line`, split on ` │ `. */
export function cellsOf(line: string | undefined): string[] {
  return (line ?? "").split(" │ ").map((cell) => cell.trim());
}
