// Ends itself with a signal no process can catch.
process.kill(process.pid, "SIGKILL");
