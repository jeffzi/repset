export default {
  include: ["bench/*.ts"],
  runtimes: ["bun", "node"],
  minTime: 0,
  minSamples: 1,
  timeout: 2_147_483_647,
  nodeImport: "tsx",
};
