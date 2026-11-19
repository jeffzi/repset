/** Windows runs no shell script as an executable, has no process groups, and no signal a process can die on or handle. */
export const POSIX = process.platform !== "win32";

/** A runtime, tsx and the command's children starting, then a short run, on a slow CI runner. */
export const SPAWN_TIMEOUT_MS = 60_000;

/** The `timeout` of a child that must not be killed, so one that never exits fails instead of hanging. */
export const KILL_AFTER_MS = 30_000;

/** How long past its `timeout` or its stop a killed child's call may take to return. */
export const RETURN_MARGIN_MS = 2000;
