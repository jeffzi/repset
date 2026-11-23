/** `count` copies of `value`. */
export function repeated<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}
