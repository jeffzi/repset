export default {
  include: ["bench/*.ts"],
  runtimes: ["bun"],
  minTime: 5,
  minSamples: 3,
  rounds: 4,
  timeout: 100,
  nodeImport: "tsx",
};
