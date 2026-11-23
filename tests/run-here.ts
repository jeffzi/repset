import { basename } from "node:path";

import type { MeasureRequest } from "../src/child-protocol.js";
import type { Outcome } from "../src/children.js";
import type { Report } from "../src/report.js";
import { run } from "../src/run.js";
import {
  answered,
  type CaseToList,
  contender,
  findAny,
  listingStarter,
  measuredOutcome,
  starter as fakeStarter,
  type StartChild,
} from "./fake-children.js";
import { fixturePath } from "./fixture-path.js";

/** The discovery fixtures, where a run starts unless told otherwise. */
export const DISCOVERY = fixturePath("discovery");

/** A stand-in for the package's `package.json` whose version is `1.2.3`. */
const VERSIONED = fixturePath("run", "version.json");

export type RunInput = Parameters<typeof run>[0];

/** The one case the fake listing child finds in `file`: named for the file, per-call only in `a.bench.ts`. */
function caseOf(file: string): { id: string; setupPerCall: boolean } {
  const id = basename(file);
  return { id, setupPerCall: id === "a.bench.ts" };
}

/** A child starter that lists one case per file and answers the rest with `answer`. */
export function starter(answer: Parameters<typeof fakeStarter>[1]): StartChild {
  return fakeStarter(caseOf, answer);
}

/** A child starter that measures every case with the median 4656. */
export const measuresAll = starter(() => measuredOutcome(4656));

/** One CPU of the fake host, as `os.cpus()` lists it. */
export function cpu(model: string): { model: string } {
  return { model };
}

/** Runs from the discovery fixtures with no config file, the fake lookup and the 1.2.3 version. */
export async function runHere(input: Partial<RunInput> = {}): ReturnType<typeof run> {
  return run({
    cwd: DISCOVERY,
    files: ["zeta.bench.ts"],
    findRuntime: findAny,
    startChild: measuresAll,
    packageJson: VERSIONED,
    cpus: () => [cpu("Apple M2 Max")],
    ...input,
  });
}

/** A contender of the contest `concat`. */
export const JOIN = contender("join");

/** Another contender of the contest `concat`. */
export const LOOP = contender("loop");

/** A third contender of the contest `concat`. */
export const PLUS = contender("plus");

/** The seed `runCases` draws unless told otherwise. */
export const SEED = 20_261_119;

/** Answers a measuring child's request; `call` counts the earlier requests for the same case. */
export type Answer = (request: MeasureRequest, call: number) => Outcome;

/** Runs `cases`, all listed in one file, drawing {@link SEED}, and logs each measuring request in start order. */
export async function runCases(
  cases: readonly CaseToList[],
  input: Partial<RunInput> = {},
  answer: Answer = (request) => answered(request),
): Promise<{ report: Report; asked: MeasureRequest[]; started: string[] }> {
  const asked: MeasureRequest[] = [];
  const report = await runHere({
    drawSeed: () => SEED,
    startChild: listingStarter([...cases], (request) => {
      if (request.mode !== "measure") throw new Error(`a ${request.mode} child started`);
      const call = asked.filter((earlier) => earlier.id === request.id).length;
      asked.push(request);
      return answer(request, call);
    }),
    ...input,
  });
  return { report, asked, started: asked.map((request) => request.id) };
}
