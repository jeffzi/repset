import { basename } from "node:path";

import { run } from "../src/run.js";
import {
  findAny,
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
