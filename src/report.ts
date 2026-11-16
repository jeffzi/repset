/**
 * The report's types: the JSON document a run returns, under the names the report format gives.
 *
 * Every key is always present, with `null` where a value does not apply, so a reader checks
 * `schema` and never a key.
 */

import type { ChildPhase, Measured } from "./child.js";
import type { Runtime } from "./measure/runtime.js";

/** Every option that shaped the run, after the caller's options and the config were merged. */
export interface ReportOptions {
  readonly runtimes: readonly Runtime[];
  /** The positional files as the caller gave them, or `null` when `include` chose the files. */
  readonly files: readonly string[] | null;
  readonly filter: string | null;
  readonly minTime: number;
  readonly minSamples: number;
  readonly rounds: null;
  readonly seed: null;
  readonly timeout: number;
  /** The module Node children import first, as the config file or the caller wrote it. */
  readonly nodeImport: string | null;
  readonly rawSamples: false;
}

/** The host the run measured on. */
export interface Machine {
  readonly os: string;
  readonly arch: string;
  /** The first listed CPU's model, or `null` when the OS lists no CPU. */
  readonly cpu: string | null;
  /** The number of logical CPUs, or `null` when the OS lists none. */
  readonly cores: number | null;
}

/** Why a case failed, with the tail of its child's stdout and stderr. */
export interface ResultError {
  readonly phase: ChildPhase;
  readonly message: string;
  readonly stack: string | null;
  readonly output: string;
}

/** One measuring process of a case; a process that failed holds `null` for what it did not reach. */
export interface Process {
  readonly round: number;
  readonly orderInRound: number;
  readonly stats: Measured["stats"] | null;
  readonly sampling: Measured["sampling"] | null;
  readonly checks: Measured["checks"] | null;
  readonly gc: Measured["gc"];
  readonly rawSamples: null;
}

/** What every result holds, whether its case was measured or failed. */
interface ResultBase {
  readonly id: string;
  readonly name: string;
  readonly contender: null;
  readonly params: Readonly<Record<string, never>>;
  /** The benchmark file, relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly runtime: { readonly name: Runtime; readonly version: string };
  readonly setupPerCall: boolean;
  readonly processes: readonly Process[];
}

/** A case that was measured: its median is the median of its processes' medians. */
export interface MeasuredResult extends ResultBase {
  readonly status: "ok";
  readonly error: null;
  readonly median: number;
}

/** A case that failed: `error` says why, and its one process holds `null` for what it did not reach. */
export interface FailedResult extends ResultBase {
  readonly status: "failed";
  readonly error: ResultError;
  readonly median: null;
}

/** One case's result on one runtime. */
export type Result = MeasuredResult | FailedResult;

/** The JSON document `run` returns; `schema` names its format version. */
export interface Report {
  readonly schema: 1;
  /** The version of repset that wrote the report. */
  readonly repset: string;
  /** When the run was called, as an ISO 8601 time. */
  readonly startedAt: string;
  /** Whether the stop signal ended the run before every case ran. */
  readonly interrupted: boolean;
  readonly options: ReportOptions;
  readonly machine: Machine;
  /** The results that finished, in run order. */
  readonly results: readonly Result[];
  readonly contests: readonly [];
}
