// The overhead check's repset side: the two bodies the baseline child times, each on a shared
// state.
// `bench` comes from the built entry, so the measuring child loads one copy of repset, the built
// one, as a user's child does.
import { bench } from "../../dist/index.js";
import { BODIES, BODY_NAMES, buildState } from "./bodies.js";

for (const body of BODY_NAMES) {
  bench(`overhead/${body}`, { setup: buildState, fn: BODIES[body] });
}
