import type {
  ChildError,
  ChildPhase,
  ListedCase,
  Measured,
  MeasureRequest,
  OnceRequest,
} from "../src/child.js";
import type {
  findRuntime,
  FoundRuntime,
  Outcome,
  StartOptions,
  startChild,
} from "../src/children.js";

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

/** A runtime lookup that finds every runtime. */
export const findAny: FindRuntime = async (runtime) => found(runtime);

/** A measurement whose median is `median`. */
export function measured(median: number): Measured {
  return {
    status: "ok",
    stats: { min: 1, p25: 2, median, p75: 4, p99: 5, max: 6, mean: 3.5, sampleCount: 64 },
    sampling: {
      timerResolutionNs: 41.7,
      callsPerSample: 2,
      callsPerSampleFixed: false,
      warmupSamples: 1000,
      timingAttempts: 1,
      timingMs: 1003.4,
    },
    checks: { ratioToEmptyBody: 120.5 },
    gc: { count: 3, minor: 3, major: 0, totalMs: 0.41, maxMs: 0.17 },
  };
}

/** An outcome in which the child measured its case with the median `median`. */
export function measuredOutcome(median: number): Outcome {
  return { status: "ok", result: measured(median), output: "" };
}

/** An outcome in which the child ran its case once. */
export const ranOnce: Outcome = { status: "ok", result: { status: "ok" }, output: "" };

/** A case to list, whose benchmark name defaults to its id and whose contender defaults to `null`. */
export type CaseToList = Pick<ListedCase, "id" | "setupPerCall"> &
  Partial<Pick<ListedCase, "name" | "contender">>;

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
