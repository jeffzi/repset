/** The largest delay a Node timer keeps, the highest timeout repset accepts. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export default {
  include: ["bench/*.ts"],
  runtimes: ["bun", "node"],
  minTime: 0,
  minSamples: 1,
  rounds: 1,
  timeout: MAX_TIMER_DELAY_MS,
  nodeImport: "tsx",
};
