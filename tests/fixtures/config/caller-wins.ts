export default {
  include: ["bench/*.ts"],
  runtimes: ["bun"],
  minTime: 5,
  minSampleCount: 3,
  contestRepetitionCount: 4,
  debug: true,
  timeout: 100,
  nodeImport: "tsx",
  measure: ["memory"],
};
