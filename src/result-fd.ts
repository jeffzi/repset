/**
 * The file descriptor a child writes its result to and the parent reads it from, so that what a
 * benchmark file prints on stdout and stderr never mixes into it.
 */
export const RESULT_FD = 3;
