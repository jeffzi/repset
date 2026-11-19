/**
 * The report's types: the JSON document a run returns, under the names the report format gives.
 *
 * Every key is always present, with `null` where a value does not apply, so a reader checks
 * `schema` and never a key.
 */

import type { ChildError, Measured } from "./child.js";
import type { Runtime } from "./measure/runtime.js";

/** Every option that shaped the run, after the caller's options and the config were merged. */
export interface ReportOptions {
  readonly runtimes: readonly Runtime[];
  /** The positional files as the caller gave them, or `null` when `include` chose the files. */
  readonly files: readonly string[] | null;
  readonly filter: string | null;
  readonly minTime: number;
  readonly minSamples: number;
  /** The `rounds` option, or `null` when each contest's size sets its count. */
  readonly rounds: number | null;
  /** The seed of the round orders, or `null` when the run holds no contest. */
  readonly seed: number | null;
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
export interface ResultError extends ChildError {
  readonly output: string;
}

/** One measuring process of a measured case, holding its statistics, sampling and checks. */
export interface MeasuredProcess extends Pick<Measured, "stats" | "sampling" | "checks" | "gc"> {
  readonly round: number;
  readonly orderInRound: number;
  readonly rawSamples: null;
}

/** The process of a failed case, holding `null` for what it did not reach. */
export interface FailedProcess {
  readonly round: number;
  readonly orderInRound: number;
  readonly stats: null;
  readonly sampling: null;
  readonly checks: null;
  readonly gc: null;
  readonly rawSamples: null;
}

/** What every result holds, whether its case was measured or failed. */
export interface ResultBase {
  readonly id: string;
  readonly name: string;
  /** The contender's key in a contest, or `null` for a plain benchmark. */
  readonly contender: string | null;
  readonly params: Readonly<Record<string, never>>;
  /** The benchmark file, relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly runtime: { readonly name: Runtime; readonly version: string };
  readonly setupPerCall: boolean;
}

/** A case that was measured: its median is the median of its processes' medians. */
export interface MeasuredResult extends ResultBase {
  readonly status: "ok";
  readonly error: null;
  readonly median: number;
  readonly processes: readonly [MeasuredProcess, ...MeasuredProcess[]];
}

/**
 * A case that failed: `error` says why, and its processes are those that ran, the failed one last,
 * holding `null` for what it did not reach.
 */
export interface FailedResult extends ResultBase {
  readonly status: "failed";
  readonly error: ResultError;
  readonly median: null;
  readonly processes: readonly [...MeasuredProcess[], FailedProcess];
}

/** One case's result on one runtime. */
export type Result = MeasuredResult | FailedResult;

/**
 * A contender of a judged contest, or of one that cannot be judged with `ratio` and `rank` `null`;
 * a failed contender has a `null` median too.
 */
export interface ContestContender {
  readonly id: string;
  readonly median: number | null;
  /** Its pair's ratio with the fastest contender, 1 for the fastest itself. */
  readonly ratio: number | null;
  /** 1 plus the number of contenders proven faster. */
  readonly rank: number | null;
}

/** The verdict on two contenders of a contest, `a` the earlier in the contest's contenders. */
export interface ContestPair {
  readonly a: string;
  readonly b: string;
  /** The exp of the Hodges–Lehmann estimate of the per-round `ln(median_b / median_a)`. */
  readonly ratio: number;
  /** The exact signed-rank interval of `ratio` at the level `1 − 0.05 / pairs`. */
  readonly interval: readonly [number, number];
  /** The exact two-sided signed-rank p value over the rounds. */
  readonly p: number;
  /** `p` adjusted by Holm's over the contest's pairs. */
  readonly pAdjusted: number;
  /** The faster contender's case id, or `null` when the pair is tied. */
  readonly faster: string | null;
}

/** One contest on one runtime: its contenders, and a verdict per pair of those that never failed. */
export interface Contest {
  readonly name: string;
  readonly params: Readonly<Record<string, never>>;
  readonly runtime: ResultBase["runtime"];
  readonly rounds: number;
  /** Sorted by rank then median, by median alone when not judged, the failed ones last. */
  readonly contenders: readonly ContestContender[];
  readonly pairs: readonly ContestPair[];
}

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
  /** The contests that finished, in run order. */
  readonly contests: readonly Contest[];
}
