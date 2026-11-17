// Scenario: keep a project's options in one file.
//
// repset reads `repset.config.ts` from the directory it starts in. Options given on the command
// line override the file's, so `npx repset --runtime node` runs Node alone.
import { defineConfig } from "repset";

export default defineConfig({
  // Globs are relative to this file.
  include: ["*.bench.ts"],
  // Every case runs on Node, then on Bun. Bun must be on your PATH.
  runtimes: ["node", "bun"],
});
