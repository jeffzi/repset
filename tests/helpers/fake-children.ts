import type {
  ChildError,
  ChildPhase,
  ListedCase,
  Measured,
  MeasuredMemory,
  MeasuredTime,
  MeasureRequest,
  OnceRequest,
} from "../../src/child-protocol.js";
import type {
  findRuntime,
  FoundRuntime,
  Outcome,
  StartOptions,
  startChild,
} from "../../src/children.js";

export type StartChild = typeof startChild;
export type FindRuntime = typeof findRuntime;
export type Runtime = FoundRuntime["runtime"];
export type Asked = MeasureRequest | OnceRequest;

/** The runtime the fake lookup finds for `runtime`. */
export function found(runtime: Runtime): FoundRuntime {
  return {
    runtime,
    executable: `/bin/${runtime}`,
    version: runtime === "node" ? "24.1.0" : "1.3.2",
  };
}

/** The runtime entry a report records for `runtime`, as the fake lookup finds it. */
export function runtimeOf(runtime: Runtime): { name: Runtime; version: string } {
  return { name: runtime, version: found(runtime).version };
}

/** A runtime lookup that finds every runtime, as {@link found} describes it. */
export const findAny: FindRuntime = async (runtime) => found(runtime);

/** A measuring child's result that timed its case and read no memory. */
export interface TimedMeasured extends Measured {
  readonly time: MeasuredTime;
}

/** A measurement whose median is `median`. */
export function measured(median: number): TimedMeasured {
  return {
    status: "ok",
    memory: null,
    time: {
      stats: { min: 1, p25: 2, median, p75: 4, p99: 5, max: 6, mean: 3.5, sampleCount: 64 },
      sampling: {
        timerResolutionNs: 41.7,
        callsPerSample: 2,
        callsPerSampleFixed: false,
        warmupSampleCount: 1000,
        timingAttemptCount: 1,
        timingMs: 1003.4,
      },
      checks: { ratioToEmptyBody: 120.5 },
      gc: {
        collectionCount: 3,
        durationMs: 0.41,
        maxDurationMs: 0.17,
        nodeMinorCollectionCount: 3,
        nodeMajorCollectionCount: 0,
      },
      rawSamples: null,
    },
  };
}

/** An outcome in which the child measured its case with the median `median`. */
export function measuredOutcome(median: number): Outcome {
  return { status: "ok", result: measured(median), output: "" };
}

/** An outcome in which the child ran its case once and it passed. */
export const ranOnce: Outcome = { status: "ok", result: { status: "ok" }, output: "" };

/** A measurement's memory block whose per-call median is `median`, with no statistics when `median` is `null`. */
export function memoryOf(median: number | null): MeasuredMemory {
  return {
    stats:
      median === null
        ? null
        : {
            min: median - 2,
            p25: median - 1,
            median,
            p75: median + 1,
            p99: median + 2,
            max: median + 3,
            mean: median + 0.5,
            sampleCount: 21,
          },
    sampling: { callsPerSample: 64 },
    rawSamples: null,
  };
}

/** The medians a fake measuring child reads: `time` in nanoseconds and `memory` in bytes per call. */
export interface Readings {
  readonly time?: number;
  readonly memory?: number | null;
}

/** An outcome measuring what `request` asks, at the medians `readings` gives (4656 ns and 40 B by default). */
export function answered(request: Asked, { time = 4656, memory = 40 }: Readings = {}): Outcome {
  if (request.mode !== "measure") return ranOnce;
  return {
    status: "ok",
    result: {
      status: "ok",
      time: request.time ? measured(time).time : null,
      memory: request.memory ? memoryOf(memory) : null,
    },
    output: "",
  };
}

/** A case to list, whose benchmark name defaults to its id and whose contender defaults to `null`. */
export interface CaseToList
  extends
    Pick<ListedCase, "id" | "setupPerCall">,
    Partial<Pick<ListedCase, "name" | "contender">> {}

/** The contender `key` of the contest `concat`. */
export function contender(key: string): CaseToList {
  return { id: `concat/${key}`, setupPerCall: false, name: "concat", contender: key };
}

/** A plain case run once per process. */
export const APPLE: CaseToList = { id: "apple", setupPerCall: false };

/** Another plain case run once per process. */
export const BANANA: CaseToList = { id: "banana", setupPerCall: false };

/** An outcome in which the child listed `cases`. */
export function listed(cases: CaseToList[]): Outcome {
  const listedCases = cases.map(
    ({ id, setupPerCall, name = id, contender: key = null }): ListedCase => ({
      id,
      setupPerCall,
      name,
      contender: key,
    }),
  );
  return { status: "ok", result: { status: "ok", cases: listedCases }, output: "" };
}

/** A child starter that fails its caller with a plain error if any child starts. */
export const startsNoChild: StartChild = async () => {
  throw new Error("a child started");
};

/** An outcome in which the stop signal killed the child. */
export const stopped: Outcome = { status: "stopped", output: "" };

/** An outcome in which the child failed in `phase` with `message`, its cleanup teardown `teardownError`. */
export function failedOutcome(
  phase: ChildPhase,
  message: string,
  teardownError: ChildError["teardownError"] = null,
): Outcome {
  return { status: "failed", error: { phase, message, stack: null, teardownError }, output: "" };
}

/** The failure of a cleanup teardown that threw an `Error`, as the child encodes it. */
export const MELON = { message: "melon", stack: "at teardown" } as const;

/** The fields of a child's own failure in phase fn, before its `teardownError`. */
export const FN_KIWI = { phase: "fn", message: "kiwi", stack: "at fn" } as const;

/** The result line of a child whose own failure is `error`. */
export function failureLine(error: object): string {
  return `${JSON.stringify({ status: "failed", error })}\n`;
}

/** What a measure request asks the child to read. */
export type MeasureKinds = Pick<MeasureRequest, "time" | "memory">;

/** A measure request's kinds when it asks for time alone. */
export const TIME_ONLY: MeasureKinds = { time: true, memory: false };

/** An answer that measures every request, and fails `concat/loop`'s second call in phase `fn` with `kiwi`. */
export function failsLoopInRepetitionTwo(): (request: Asked) => Outcome {
  let loopCalls = 0;
  return (request) => {
    if (request.id !== "concat/loop") return measuredOutcome(4656);
    loopCalls += 1;
    return loopCalls === 2 ? failedOutcome("fn", "kiwi") : measuredOutcome(17);
  };
}

/** A child starter that lists the one case `listCase` gives per file and answers the rest with `answer`. */
export function starter(
  listCase: (file: string) => CaseToList,
  answer: (
    request: Asked,
    runtime: FoundRuntime,
    options: StartOptions,
  ) => Outcome | Promise<Outcome>,
): StartChild {
  return async (runtime, request, options) => {
    if (request.mode === "list") return listed([listCase(request.file)]);
    return answer(request, runtime, options);
  };
}

/** A child starter that lists `cases` in every file and answers the rest with `answer`. */
export function listingStarter(
  cases: CaseToList[],
  answer: (request: Asked, runtime: FoundRuntime) => Outcome | Promise<Outcome>,
): StartChild {
  return async (runtime, request) => {
    if (request.mode === "list") return listed(cases);
    return answer(request, runtime);
  };
}
