/** Matches a line that inserts each of `pieces` as whole words, in order. */
export function wordsInOrder(...pieces: readonly (number | string)[]): RegExp {
  const words = pieces.map((piece) =>
    String(piece).replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`),
  );
  return new RegExp(String.raw`\b${words.join(String.raw`\b.*\b`)}\b`, "u");
}
