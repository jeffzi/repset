import { describe, expect, it } from "vitest";

import { crashReport } from "../src/command.js";

describe("crashReport", () => {
  const OS = "darwin 25.6.0 arm64";
  const RUNTIME = "node 26.1.0";

  /** The last word of `text`, where the report puts its link. */
  function linkOf(text: string): string {
    return text.trimEnd().split(/\s/u).at(-1) ?? "";
  }

  /** The report's last line without its link: what a person reads beside it. */
  function readLine(text: string): string {
    const last = text.trimEnd().split("\n").at(-1) ?? "";
    return last.slice(0, last.lastIndexOf(" "));
  }

  /** The issue body the link ending `text` carries, decoded strictly, or `undefined` for none. */
  function issueBody(text: string): string | undefined {
    const encoded = /[?&]body=([^&]*)/u.exec(new URL(linkOf(text)).search)?.[1];
    return encoded === undefined ? undefined : decodeURIComponent(encoded.replaceAll("+", " "));
  }

  describe("when the version was read", () => {
    const error = new Error("kiwi & banana? #1 100%");
    const platform = { version: "1.2.3", os: OS, runtime: RUNTIME };

    it("prints the stack first", () => {
      const text = crashReport(error, platform);

      expect(text.startsWith(error.stack ?? "")).toBe(true);
    });

    it("names the version and platform on its last line", () => {
      const text = crashReport(error, platform);

      expect(["1.2.3", OS, RUNTIME].map((word) => readLine(text).includes(word))).toStrictEqual([
        true,
        true,
        true,
      ]);
    });

    it("links an issue prefilled with the version, platform and message", () => {
      const text = crashReport(error, platform);

      const body = issueBody(text) ?? "";

      expect(
        ["1.2.3", OS, RUNTIME, "kiwi & banana? #1 100%"].map((word) => body.includes(word)),
      ).toStrictEqual([true, true, true, true]);
    });
  });

  describe("when the version could not be read", () => {
    it("names the version as unknown", () => {
      const error = new Error("kiwi");

      const text = crashReport(error, { version: undefined, os: OS, runtime: RUNTIME });

      expect({
        line: readLine(text).includes("unknown"),
        body: issueBody(text)?.includes("unknown"),
      }).toStrictEqual({ line: true, body: true });
    });
  });

  describe("when the message is long", () => {
    const message = Array.from({ length: 3000 }, (_, index) => `${index}🍌`).join("");
    const platform = { version: "1.2.3", os: OS, runtime: RUNTIME };

    it("keeps the link within 6000 characters, filled to within one code point", () => {
      const text = crashReport(new Error(message), platform);

      const length = linkOf(text).length;
      // One code point encodes to at most 12 characters, so a fuller cut would not have fit.
      expect(length > 6000 - 12 && length <= 6000).toBe(true);
    });

    it("cuts the message on a whole character", () => {
      const text = crashReport(new Error(message), platform);

      // `issueBody` decodes strictly, so a cut through a code point throws here.
      const body = issueBody(text) ?? "";
      const kept = body.slice(
        body.indexOf("```text\n") + "```text\n".length,
        body.lastIndexOf("\n```"),
      );
      expect(kept.startsWith("0🍌1🍌") && message.startsWith(kept)).toBe(true);
    });
  });
});
