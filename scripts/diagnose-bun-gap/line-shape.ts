/**
 * The fields of a diagnosis run file's header and reading lines, the type each field holds, and
 * the check that a parsed line's field holds it.
 */
import { isRecord } from "../../src/utils.js";
import type { BodyName } from "../check-timing-accuracy/bodies.js";

/** The type each kind of record field holds. */
interface FieldTypes {
  string: string;
  number: number;
  boolean: boolean;
  "string?": string | null;
  "number?": number | null;
  strings: string[];
  counts: { each: number; inlined: number };
  body: BodyName;
}

type FieldKind = keyof FieldTypes;

const CHECKS: { readonly [Kind in FieldKind]: (value: unknown) => boolean } = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  boolean: (value) => typeof value === "boolean",
  "string?": (value) => value === null || typeof value === "string",
  "number?": (value) => value === null || typeof value === "number",
  strings: (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  counts: (value) =>
    isRecord(value) && typeof value["each"] === "number" && typeof value["inlined"] === "number",
  body: (value) => value === "each" || value === "inlined",
};

/** The fields of a header line after `kind`; the `Header` type derives from it. */
export const HEADER_FIELDS = {
  cpuModel: "string?",
  cpuCount: "number",
  kernel: "string",
  sysVendor: "string?",
  productName: "string?",
  bunVersion: "string",
  nodeVersion: "string",
  commit: "string",
  runId: "string?",
  runAttempt: "string?",
  pinned: "boolean",
  cyclesPerBody: "number",
  sides: "strings",
  sampleCounts: "counts",
} as const satisfies Record<string, FieldKind>;

/** The fields of a reading line after `kind`; the `Reading` type derives from it. */
export const READING_FIELDS = {
  cycle: "number",
  position: "number",
  body: "body",
  side: "string",
  median: "number",
  sampleCount: "number",
  firstHalfMedian: "number?",
  secondHalfMedian: "number?",
  p75: "number?",
  p99: "number?",
  cpuStart: "number?",
  cpuEnd: "number?",
  pinnedCpu: "number?",
  time: "string",
} as const satisfies Record<string, FieldKind>;

/**
 * A parsed readings-file line: its `kind` plus one property per entry of `Fields`, typed by the
 * field's kind. `Header` and `Reading` in `parse-input.ts` are built from it.
 */
export type Line<Kind extends string, Fields extends Record<string, FieldKind>> = { kind: Kind } & {
  -readonly [Name in keyof Fields]: FieldTypes[Fields[Name]];
};

/** Whether every field of `value` named in `fields` holds the type its kind admits. */
export function hasFields(
  value: Record<string, unknown>,
  fields: Record<string, FieldKind>,
): boolean {
  return Object.entries(fields).every(([name, kind]) => CHECKS[kind](value[name]));
}
