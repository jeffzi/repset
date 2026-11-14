/** A timer step fine enough that 100 ms samples span far more than 200 steps. */
export const FINE_STEP = 2 ** -10;

/** A timer step coarse enough that short samples span few steps or none. */
export const COARSE_STEP = 2 ** -4;
