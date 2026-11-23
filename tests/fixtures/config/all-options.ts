/** The largest delay a Node timer keeps, the highest timeout repset accepts. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export default {
  include: ["bench/*.ts"],
  runtimes: ["bun", "node"],
  minTime: 0,
  minSampleCount: 1,
  contestRepetitionCount: 1,
  debug: true,
  timeout: MAX_TIMER_DELAY_MS,
  nodeImport: "tsx",
  measure: ["memory", "time"],
};
