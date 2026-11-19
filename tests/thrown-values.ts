/** An `Error` with the message "fig" whose `stack` getter throws. */
export function unreadableStackError(): Error {
  return Object.defineProperty(new Error("fig"), "stack", {
    get: () => {
      throw new Error("trap");
    },
  });
}

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
