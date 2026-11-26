// Prints `plum`, then exits with the status its first argument names.
process.stdout.write("plum\n");
process.exitCode = Number(process.argv[2]);
