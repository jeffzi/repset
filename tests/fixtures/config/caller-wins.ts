export default {
  include: ["bench/*.ts"],
  runtimes: ["bun"],
  minTime: 5,
  minSamples: 3,
  timeout: 100,
  nodeImport: "tsx",
};
