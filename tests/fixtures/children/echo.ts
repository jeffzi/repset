import { writeSync } from "node:fs";

// Writes its request's `file` field to file descriptor 3 verbatim, so a test picks the line.
const request: unknown = JSON.parse(process.argv[2] ?? "null");
const line =
  typeof request === "object" && request !== null && "file" in request ? request.file : null;
if (typeof line !== "string") throw new TypeError("the request holds no file");
writeSync(3, line);
