/** A timer resolution fine enough that 100 ms samples span far more than 200 times the resolution. */
export const FINE_RESOLUTION = 2 ** -10;

/** A timer resolution coarse enough that short samples span few multiples of the resolution or none. */
export const COARSE_RESOLUTION = 2 ** -4;

/** Returns the Error a call throws, failing the test when it throws nothing or a non-Error. */
export function errorOf(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("threw a non-Error value", { cause: error });
  }
  throw new Error("did not throw");
}
