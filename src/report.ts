/**
 * The report's types: the JSON document a run returns, under the names the report format gives.
 *
 * Every key is always present, with `null` where a value does not apply, so a reader checks
 * `schema` and never a key.
 */

import type { ChildError, ListedCase, MeasuredTime } from "./child.js";
import type { Runtime } from "./measure/runtime.js";

/** Every option that shaped the run, after the caller's options and the config were merged. */
export interface ReportOptions {
  readonly runtimes: readonly Runtime[];
  /** The positional files as the caller gave them, or `null` when `include` chose the files. */
  readonly files: readonly string[] | null;
  readonly filter: string | null;
  readonly minTime: number;
  readonly minSampleCount: number;
  /** The `contestRepetitionCount` option, or `null` when each contest's size sets its count. */
  readonly contestRepetitionCount: number | null;
  readonly debug: boolean;
  /** The seed of the repetition orders, or `null` when the run holds no contest. */
  readonly seed: number | null;
  readonly timeout: number;
  /** The module Node children import first, as the config file or the caller wrote it. */
  readonly nodeImport: string | null;
  readonly rawSamples: false;
}

/** The host the run measured on. */
export interface Host {
  readonly os: string;
  readonly arch: string;
  /** The first listed CPU's model, or `null` when the OS lists no CPU. */
  readonly cpu: string | null;
  /** The number of logical CPUs, or `null` when the OS lists none. */
  readonly coreCount: number | null;
}

/** Why a case failed, with the tail of its child's stdout and stderr. */
export interface ResultError extends ChildError {
  readonly output: string;
}

/**
 * One measuring child of a case: its repetition and its order in it, both from 1 for a contender
 * and `null` for a plain case, which has no repetition.
 */
interface MeasurementPlace {
  readonly repetition: number | null;
  readonly orderInRepetition: number | null;
}

/**
 * The measurement of one measuring child that measured its case; its `time.gc` is `null` unless the
 * `debug` option is on, whatever the runtime delivers.
 */
export interface CaseMeasurement extends MeasurementPlace {
  readonly time: MeasuredTime;
}

/** The measurement of the measuring child that failed, holding `null` for the time it did not take. */
interface FailedMeasurement extends MeasurementPlace {
  readonly time: null;
}

/** A case's headline time: the median of its measurements' medians, in nanoseconds per call. */
export interface HeadlineTime {
  readonly unit: "ns/call";
  readonly median: number;
}

/** What every result holds, whether its case was measured or failed. */
export interface ResultBase extends Pick<ListedCase, "id" | "name" | "contender" | "setupPerCall"> {
  readonly params: Readonly<Record<string, never>>;
  /** The benchmark file, relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly runtime: { readonly name: Runtime; readonly version: string };
}

/** A case that was measured, one measurement per measuring child. */
export interface MeasuredResult extends ResultBase {
  readonly status: "ok";
  readonly error: null;
  readonly time: HeadlineTime;
  readonly measurements: readonly [CaseMeasurement, ...CaseMeasurement[]];
}

/**
 * A case that failed: `error` says why, and its measurements are those of the children that ran,
 * the failed one last, holding `null` for the time it did not take.
 */
export interface FailedResult extends ResultBase {
  readonly status: "failed";
  readonly error: ResultError;
  readonly time: null;
  readonly measurements: readonly [...CaseMeasurement[], FailedMeasurement];
}

/** One case's result on one runtime. */
export type Result = MeasuredResult | FailedResult;

/**
 * A contender of a judged contest, or of one that cannot be judged with `ratio` and `rank` `null`;
 * a failed contender has a `null` time too.
 */
export interface ContestContender {
  readonly id: string;
  readonly time: HeadlineTime | null;
  /** Its pair's ratio with the fastest contender, 1 for the fastest itself. */
  readonly ratio: number | null;
  /** 1 plus the number of contenders proven faster. */
  readonly rank: number | null;
}

/** The verdict on two contenders of a contest, `a` the earlier in the contest's contenders. */
export interface ContestPair {
  readonly a: string;
  readonly b: string;
  /** The exp of the Hodges–Lehmann estimate of the per-repetition `ln(median_b / median_a)`. */
  readonly ratio: number;
  /** The exact signed-rank interval of `ratio` at the level `1 − 0.05 / pairs`. */
  readonly interval: readonly [number, number];
  /** The exact two-sided signed-rank p value over the repetitions. */
  readonly p: number;
  /** `p` adjusted by Holm's over the contest's pairs. */
  readonly pAdjusted: number;
  /** The faster contender's case id, or `null` when the pair is tied. */
  readonly faster: string | null;
  /**
   * Why the pair has no verdict:
   *
   * - `"repetitions"`: `pAdjusted` is above 0.05, so the repetitions did not tell the contenders
   *   apart.
   * - `"timer"`: `pAdjusted` is at most 0.05, but `ratio` is within 1.25 timer resolutions per
   *   call of 1, a gap too small for the timer to measure.
   * - `null`: the pair is proven, and `faster` names the faster contender.
   */
  readonly tie: "repetitions" | "timer" | null;
}

/** One contest on one runtime: its contenders, and a verdict per pair of those that never failed. */
export interface Contest {
  readonly name: string;
  readonly params: Readonly<Record<string, never>>;
  readonly runtime: ResultBase["runtime"];
  readonly repetitionCount: number;
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
  readonly host: Host;
  /** The results that finished, in run order. */
  readonly results: readonly Result[];
  /** The contests that finished, in run order. */
  readonly contests: readonly Contest[];
}
