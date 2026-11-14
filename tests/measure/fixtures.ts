/** A timer resolution fine enough that 100 ms samples span far more than 200 times the resolution. */
export const FINE_RESOLUTION = 2 ** -10;

/** A timer resolution coarse enough that short samples span few multiples of the resolution or none. */
export const COARSE_RESOLUTION = 2 ** -4;
