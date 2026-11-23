/** A value whose `instanceof` check throws, as a Proxy's `getPrototypeOf` trap can. */
export function trappedProxy(): object {
  return new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("trap");
      },
    },
  );
}
