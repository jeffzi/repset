/**
 * Runs `call` and hands back the error it throws, so a test can assert on it.
 *
 * @param call - The synchronous function expected to throw.
 * @returns The `Error` that `call` threw.
 * @throws Error `threw a non-Error value` when `call` throws something that is not an `Error`; the
 * thrown value is its `cause`.
 * @throws TypeError `errorOf takes a synchronous call` when `call` returns a promise.
 * @throws Error `did not throw` when `call` returns anything else without throwing.
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
