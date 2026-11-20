const LINGER_MS = 5000;

// Ignores the signals it can catch, and ends by itself so a failed test leaves no process behind.
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
setTimeout(() => undefined, LINGER_MS);
