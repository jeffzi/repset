// The timing accuracy check's repset side: the two bodies the baseline child times, each on a shared
// state.
// `bench` comes from the built entry, so the measuring child loads one copy of repset, the built
// one, as a user's child does.
import { bench } from "../../dist/index.js";
import { BODIES, BODY_NAMES, benchName, buildState } from "./bodies.js";

for (const name of BODY_NAMES) {
  bench(benchName(name), { setup: buildState, fn: BODIES[name] });
}
