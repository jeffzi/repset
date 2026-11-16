/**
 * Returns the Error a synchronous call throws, failing the test when it throws nothing, a non-Error,
 * or returns a promise.
 *
 * @param call - The synchronous call expected to throw.
 * @returns The Error the call threw.
 * @throws {Error} When the call returns a promise, throws a non-Error, or throws nothing.
 */
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
