import { writeFileSync, writeSync } from "node:fs";

const LINGER_MS = 5000;

// Writes its result, then creates the file its request's `file` field names, so a test knows the
// line is out before it acts.
writeSync(3, '{"status":"ok"}\n');
const request: unknown = JSON.parse(process.argv[2] ?? "null");
const marker =
  typeof request === "object" && request !== null && "file" in request ? request.file : null;
if (typeof marker !== "string") throw new TypeError("the request holds no file");
writeFileSync(marker, "");

// Ends by itself so a failed test leaves no process behind.
setTimeout(() => undefined, LINGER_MS);
