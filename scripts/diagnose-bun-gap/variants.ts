// The baseline variants of the Bun gap diagnosis: the names the variant child times and the driver
// runs.

/**
 * Every variant, in the driver's default order.
 *
 * - `none` times the body as the timing accuracy check's baseline child does.
 * - The next six each add one of repset's code differences to `none`; `all-six` adds all of them.
 * - `repset-buffer` holds the spans in a store sized as repset sizes its own; `repset-loaded` first
 *   loads the modules repset's child loads; `repset-sampler` times through repset's own sampler.
 */
export const VARIANTS = [
  "none",
  "clock-wrapper",
  "sample-function",
  "stored-result",
  "indirect-access",
  "clock-between-samples",
  "timed-warmup",
  "all-six",
  "repset-buffer",
  "repset-loaded",
  "repset-sampler",
] as const;

/** One of the names in {@link VARIANTS}. */
export type Variant = (typeof VARIANTS)[number];

/** Reports whether `value` is one of {@link VARIANTS}, narrowing it to {@link Variant}. */
export function isVariant(value: string): value is Variant {
  return VARIANTS.some((known) => known === value);
}
