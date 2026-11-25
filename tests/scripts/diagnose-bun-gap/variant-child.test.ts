import { describe, expect, it } from "vitest";

import { lastCpu } from "../../../scripts/diagnose-bun-gap/variant-child.js";

const PID = 1234;

/** A `/proc/<pid>/stat` line for `PID` whose command name is `name` and whose `processor` field is `cpu`. */
function statLine(name: string, cpu: string): string {
  const beforeCpu = ["R", ...Array.from({ length: 35 }, (_, index) => String(index + 1))];
  const afterCpu = Array.from({ length: 13 }, () => "0");
  return `${PID} (${name}) ${[...beforeCpu, cpu, ...afterCpu].join(" ")}\n`;
}

/** Builds a read error carrying a Node errno code, as `readFileSync` reports it. */
function readError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: cannot open /proc/${PID}/stat`), { code });
}

/** A reader that holds only `/proc/<PID>/stat` with `text`, and fails with ENOENT for any other path. */
function procWith(text: string): (path: string) => string {
  return (path) => {
    if (path !== `/proc/${PID}/stat`) {
      throw readError("ENOENT");
    }
    return text;
  };
}

describe("lastCpu", () => {
  describe("when the stat line is well formed", () => {
    it.each([
      { case: "a plain command name", name: "node" },
      { case: "a command name with spaces and parentheses", name: "my (odd) 7 name)" },
    ])("returns the processor field after $case", ({ name }) => {
      const read = procWith(statLine(name, "5"));

      const cpu = lastCpu(PID, read);

      expect(cpu).toBe(5);
    });
  });

  describe("when the stat file is missing", () => {
    it("returns null", () => {
      const read = procWith(statLine("node", "5"));

      const cpu = lastCpu(PID + 1, read);

      expect(cpu).toBeNull();
    });
  });

  describe("when the stat line is malformed", () => {
    it.each([
      { case: "too few fields after the command name", line: `${PID} (node) R 1 2 3\n` },
      { case: "a negative processor field", line: statLine("node", "-1") },
      { case: "a non-integer processor field", line: statLine("node", "2.5") },
      { case: "no command name", line: statLine("node", "5").replaceAll(/[()]/g, "") },
    ])("throws naming the line it read, with $case", ({ line }) => {
      const read = procWith(line);

      const act = (): number | null => lastCpu(PID, read);

      expect(act).toThrow(line.trim());
    });
  });

  describe("when reading fails for another reason", () => {
    it("propagates the read error", () => {
      const denied = readError("EACCES");
      const read = (): string => {
        throw denied;
      };

      const act = (): number | null => lastCpu(PID, read);

      expect(act).toThrow(denied);
    });
  });
});
