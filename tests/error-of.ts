/** The Error a synchronous call throws; fails the test on no throw, a non-Error or a promise. */
export function errorOf(call: () => unknown): Error {
  let returned: unknown;
  try {
    returned = call();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("threw a non-Error value", { cause: error });
  }
  if (returned instanceof Promise) {
    returned.catch(() => undefined);
    throw new TypeError("errorOf takes a synchronous call");
  }
  throw new Error("did not throw");
}
