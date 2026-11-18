import { describe, expect, it } from "vitest";

import { crashReport } from "../src/command.js";

describe("crashReport", () => {
  const ISSUE = "https://github.com/jeffzi/repset/issues/new?body=";
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

  /** The issue body the link ending `text` carries, decoded strictly, or `undefined` for no link. */
  function issueBody(text: string): string | undefined {
    const link = linkOf(text);
    if (!link.startsWith(ISSUE)) return undefined;
    return decodeURIComponent(link.slice(ISSUE.length).replaceAll("+", " "));
  }

  it("prints the stack, then names the version and platform and links an issue prefilled with them and the message", () => {
    const error = new Error("kiwi & banana? #1 100%");
    const stack = error.stack ?? "";

    const text = crashReport(error, { version: "1.2.3", os: OS, runtime: RUNTIME });

    const body = issueBody(text) ?? "";
    expect({
      stackFirst: text.startsWith(stack),
      line: ["1.2.3", OS, RUNTIME].map((word) => readLine(text).includes(word)),
      body: [
        body.includes("1.2.3"),
        body.includes(OS),
        body.includes(RUNTIME),
        body.includes("kiwi & banana? #1 100%"),
      ],
    }).toStrictEqual({
      stackFirst: true,
      line: [true, true, true],
      body: [true, true, true, true],
    });
  });

  it("names the version as unknown when it could not be read", () => {
    const error = new Error("kiwi");

    const text = crashReport(error, { version: undefined, os: OS, runtime: RUNTIME });

    expect({
      line: readLine(text).includes("unknown"),
      body: issueBody(text)?.includes("unknown"),
    }).toStrictEqual({ line: true, body: true });
  });

  it("cuts a long message on a whole character so the link stays within 6000 characters and decodes", () => {
    const message = Array.from({ length: 3000 }, (_, index) => `${index}🍌`).join("");

    const text = crashReport(new Error(message), { version: "1.2.3", os: OS, runtime: RUNTIME });

    const link = linkOf(text);
    const body = issueBody(text) ?? "";
    const kept = body.slice(
      body.indexOf("```text\n") + "```text\n".length,
      body.lastIndexOf("\n```"),
    );
    // One code point encodes to at most 12 characters, so a fuller cut would not have fit.
    expect({
      full: link.length > 6000 - 12 && link.length <= 6000,
      wellFormed: body.isWellFormed(),
      start: kept.startsWith("0🍌1🍌") && message.startsWith(kept),
    }).toStrictEqual({ full: true, wellFormed: true, start: true });
  });
});
