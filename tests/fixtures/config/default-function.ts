/** A config whose default export is a function instead of a plain object; the loader must reject it. */
export default function config(): object {
  return {};
}
