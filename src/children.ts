/**
 * The parent side of a child: finding the runtimes children run on, and starting the child entry
 * on one of them to read back its result.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type {
  ChildError,
  ChildPhase,
  ChildRequest,
  ChildResult,
  Failed,
  Listed,
  ListedCase,
  Measured,
  Ran,
  SamplingReport,
} from "./child.js";
import type { GcDuringTiming } from "./measure/collections.js";
import type { Statistics } from "./measure/measure.js";
import { type Runtime, runningRuntime } from "./measure/runtime.js";
import { ConfigError } from "./options.js";
import { RESULT_FD } from "./result-fd.js";
import { isRecord, thrownMessage } from "./utils.js";

/** The child entry beside `moduleFile`, with its extension: `child.js` built, `child.ts` from source. */
function childEntryBeside(moduleFile: string): string {
  return join(dirname(moduleFile), `child${extname(moduleFile)}`);
}

const CHILD_ENTRY = childEntryBeside(fileURLToPath(import.meta.url));

/** How much of the child's stdout and stderr an outcome keeps, from the end. */
const OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * How long to wait for the child's pipes to close once it exited. A process the child started can
 * hold them open for as long as it lives, and the call must not wait for it.
 */
const CLOSE_GRACE_MS = 250;

/** How much of a result line that does not answer its request a failure message quotes. */
const QUOTED_LINE_CHARS = 200;

/** A runtime children can start on: the executable to spawn and the version it reports. */
export interface FoundRuntime {
  readonly runtime: Runtime;
  readonly executable: string;
  readonly version: string;
}

/** How a child is started beside its runtime and request. */
export interface StartOptions {
  /** How many milliseconds the child may run before it is killed. */
  readonly timeout: number;
  /** The module a Node child imports first; a Bun child ignores it. */
  readonly nodeImport: string | undefined;
  /** Kills the child when it fires; the call then ends as stopped. */
  readonly signal?: AbortSignal | undefined;
  /** The file to start in place of the child entry beside this module. */
  readonly entry?: string | undefined;
}

/** What every outcome carries beside its status. */
interface Captured {
  /** The last 16 KiB of the child's stdout and stderr, merged in the order their chunks arrived. */
  readonly output: string;
}

interface Succeeded extends Captured {
  readonly status: "ok";
  readonly result: Exclude<ChildResult, Failed>;
}

interface ChildFailed extends Captured {
  readonly status: "failed";
  readonly error: ChildError;
}

interface Stopped extends Captured {
  readonly status: "stopped";
}

/** How a child's call ended: its result, a failure, or a stop the caller asked for. */
export type Outcome = Succeeded | ChildFailed | Stopped;

/**
 * How the child process ended: stopped by the caller's signal, killed at its timeout, or exited on
 * its own, with `code` `null` when a signal ended it and `signal` `null` otherwise.
 */
type Ending =
  | { readonly kind: "stopped" }
  | { readonly kind: "timeout" }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null };

/** Every {@link ChildPhase}: a phase missing here fails to compile. */
const CHILD_PHASE_KEYS: Readonly<Record<ChildPhase, true>> = {
  setup: true,
  fn: true,
  teardown: true,
  "optimized-away": true,
  calibration: true,
  child: true,
  load: true,
};

const CHILD_PHASES: ReadonlySet<string> = new Set(Object.keys(CHILD_PHASE_KEYS));

/** Every key of {@link Statistics}: a key missing here fails to compile. */
const STATISTIC_KEYS: Readonly<Record<keyof Statistics, true>> = {
  min: true,
  p25: true,
  median: true,
  p75: true,
  p99: true,
  max: true,
  mean: true,
  sampleCount: true,
};

const STATISTICS = Object.keys(STATISTIC_KEYS);

/** Every numeric key of a child's sampling report: a key missing here fails to compile. */
const SAMPLING_NUMBER_KEYS: Readonly<
  Record<Exclude<keyof SamplingReport, "callsPerSampleFixed">, true>
> = {
  timerResolutionNs: true,
  callsPerSample: true,
  warmupSamples: true,
  timingAttempts: true,
  timingMs: true,
};

const SAMPLING_NUMBERS = Object.keys(SAMPLING_NUMBER_KEYS);

/** Every key of {@link GcDuringTiming}: a key missing here fails to compile. */
const GC_NUMBER_KEYS: Readonly<Record<keyof GcDuringTiming, true>> = {
  count: true,
  minor: true,
  major: true,
  totalMs: true,
  maxMs: true,
};

const GC_NUMBERS = Object.keys(GC_NUMBER_KEYS);

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

/**
 * Finds the executable a runtime's children start on, and its version.
 *
 * The runtime the parent runs on is its own executable, with the version from `process.versions`.
 * The other one is looked up by name on `PATH` and probed with `--version`.
 *
 * @param runtime - The runtime to find.
 * @returns The executable and the version it reports, without a leading `v`.
 * @throws {@link ConfigError} When no executable for `runtime` is on `PATH`, or its probe exits
 *   non-zero, dies on a signal, cannot be started or prints nothing.
 * @throws Error When `process.versions` holds no version for the runtime this process runs on.
 */
export async function findRuntime(runtime: Runtime): Promise<FoundRuntime> {
  if (runtime === runningRuntime()) {
    return { runtime, executable: process.execPath, version: ownVersion(runtime) };
  }
  const executable = onPath(runtime);
  if (executable === undefined) throw new ConfigError(`no ${runtime} executable on PATH`);
  return { runtime, executable, version: await probeVersion(executable) };
}

/**
 * Reads the version of the runtime this process runs on.
 *
 * @param runtime - The runtime this process runs on.
 * @returns Its version from `process.versions`.
 * @throws Error when `process.versions` holds none for it.
 */
function ownVersion(runtime: Runtime): string {
  const version = process.versions[runtime];
  if (version === undefined) throw new Error(`process.versions holds no ${runtime} version`);
  return version;
}

/** The first executable file named `name` in a `PATH` directory, or `undefined` when none is. */
function onPath(name: string): string | undefined {
  // Without a shell, Windows starts only these, so a `.cmd` on PATH would be found but not run.
  const extensions = process.platform === "win32" ? [".com", ".exe"] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether `path` is a file this process may execute; a path that cannot be read is not one. */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs `<executable> --version`.
 *
 * @param executable - The executable to probe.
 * @returns What it printed on stdout, trimmed and without a leading `v`.
 * @throws {@link ConfigError} When the probe cannot be started, exits non-zero, dies on a signal or
 *   prints nothing.
 */
async function probeVersion(executable: string): Promise<string> {
  const probe = spawn(executable, ["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const decoder = new StringDecoder("utf8");
  let printed = "";
  probe.stdout.on("data", (chunk: Buffer) => {
    printed += decoder.write(chunk);
  });
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
    probe.once("error", (error) => {
      reject(
        new ConfigError(`cannot run ${executable} --version: ${error.message}`, { cause: error }),
      );
    });
    probe.once("close", (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal]);
    });
  });
  if (signal !== null) throw new ConfigError(`${executable} --version was killed by ${signal}`);
  if (code !== 0) {
    throw new ConfigError(`${executable} --version exited with status ${code ?? "unknown"}`);
  }
  const version = (printed + decoder.end()).trim().replace(/^v/, "");
  if (version === "") throw new ConfigError(`${executable} --version printed nothing`);
  return version;
}

// ---------------------------------------------------------------------------
// Child process and output capture
// ---------------------------------------------------------------------------

/** Keeps the end of what a child prints, each stream decoded on its own so no character splits. */
class OutputTail {
  readonly #chunks: string[] = [];
  #bytes = 0;

  /** A sink for one stream's chunks, decoded as UTF-8. */
  stream(): { write: (chunk: Buffer) => void; end: () => void } {
    const decoder = new StringDecoder("utf8");
    return {
      write: (chunk) => {
        this.#add(decoder.write(chunk));
      },
      end: () => {
        this.#add(decoder.end());
      },
    };
  }

  /** The last {@link OUTPUT_TAIL_BYTES} bytes kept, cut forward to a character boundary. */
  text(): string {
    const kept = Buffer.from(this.#chunks.join(""), "utf8");
    let start = Math.max(0, kept.length - OUTPUT_TAIL_BYTES);
    // A UTF-8 continuation byte is 0b10xxxxxx; the cut moves past the rest of a split character.
    while (start > 0 && start < kept.length && ((kept[start] ?? 0) & 0xc0) === 0x80) start += 1;
    return kept.toString("utf8", start);
  }

  #add(text: string): void {
    if (text === "") return;
    this.#chunks.push(text);
    this.#bytes += Buffer.byteLength(text);
    let first = this.#chunks[0];
    while (first !== undefined && this.#bytes - Buffer.byteLength(first) >= OUTPUT_TAIL_BYTES) {
      this.#chunks.shift();
      this.#bytes -= Buffer.byteLength(first);
      first = this.#chunks[0];
    }
  }
}

/**
 * Starts the child entry on one runtime with one request, in this process's working directory, and
 * reads back its result.
 *
 * Nothing the child prints reaches this process's stdout or stderr.
 *
 * @param runtime - The runtime to start the child on.
 * @param request - What the child is asked to do.
 * @param options - The child's timeout, the module a Node child imports first, the caller's stop
 *   signal, and the file to start in place of the child entry.
 * @returns The child's result, the child's own failure, a failure in phase `child` when it left no
 *   result that answers `request`, could not start or ran past `timeout`, or a stop when `signal`
 *   fired while it ran. Each carries the last 16 KiB the child printed. A result line the child
 *   wrote stands however the child then ended.
 */
export async function startChild(
  runtime: FoundRuntime,
  request: ChildRequest,
  options: StartOptions,
): Promise<Outcome> {
  const { timeout, signal } = options;
  const { child, tail, written } = spawnChild(runtime, request, options);

  return new Promise<Outcome>((resolve) => {
    let ending: Ending | undefined;
    let settled = false;
    const kill = (kind: "stopped" | "timeout"): void => {
      ending ??= { kind };
      child.kill("SIGKILL");
    };
    const stop = (): void => {
      kill("stopped");
    };
    const timer = setTimeout(kill, timeout, "timeout");
    if (signal?.aborted === true) stop();
    signal?.addEventListener("abort", stop, { once: true });

    const disarm = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    const settle = (outcome: (output: string) => Outcome): void => {
      if (settled) return;
      settled = true;
      disarm();
      for (const stream of child.stdio) stream?.destroy();
      resolve(outcome(tail.text()));
    };

    child.once("error", (error) => {
      settle((output) => noResult(`could not start the child: ${error.message}`, output));
    });
    child.once("exit", (code, exitSignal) => {
      disarm();
      const ended = ending ?? { kind: "exit", code, signal: exitSignal };
      const finish = (): void => {
        settle((output) => outcomeOf(ended, readResult(written(), request.mode), timeout, output));
      };
      const grace = setTimeout(finish, CLOSE_GRACE_MS);
      child.once("close", () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}

/** A child process just started, and what it prints and writes as it runs. */
interface StartedChild {
  readonly child: ChildProcess;
  readonly tail: OutputTail;
  /** Everything the child wrote on file descriptor 3 so far. */
  readonly written: () => string;
}

/**
 * Spawns `runtime` on the child entry, or on `options.entry`, with `request` as its argument.
 *
 * @param runtime - The runtime to start the child on.
 * @param request - What the child is asked to do.
 * @param options - The module a Node child imports first, and the file to start in place of the
 *   child entry.
 * @returns The process, the tail of its stdout and stderr, and a reader of its file descriptor 3.
 */
function spawnChild(
  runtime: FoundRuntime,
  request: ChildRequest,
  options: Pick<StartOptions, "nodeImport" | "entry">,
): StartedChild {
  const { nodeImport, entry = CHILD_ENTRY } = options;
  const imports =
    runtime.runtime === "node" && nodeImport !== undefined ? ["--import", nodeImport] : [];
  const child = spawn(
    runtime.executable,
    ["--expose-gc", ...imports, entry, JSON.stringify(request)],
    { stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true },
  );
  const tail = new OutputTail();
  for (const stream of [child.stdout, child.stderr]) {
    const sink = tail.stream();
    stream?.on("data", sink.write);
    stream?.on("end", sink.end);
  }
  const fd3: Buffer[] = [];
  child.stdio[RESULT_FD]?.on("data", (chunk: Buffer) => {
    fd3.push(chunk);
  });
  return { child, tail, written: () => Buffer.concat(fd3).toString("utf8") };
}

/**
 * Builds the outcome of a child that ended.
 *
 * @param ending - How the child ended.
 * @param read - The result the child wrote, or what was wrong with what it wrote.
 * @param timeout - The child's timeout, which a timed-out child's failure names.
 * @param output - The tail of the child's stdout and stderr.
 * @returns A stop when the caller stopped the child; otherwise the result or the child's own
 *   failure when it wrote one, or a failure in phase `child` saying how it ended.
 */
function outcomeOf(
  ending: Ending,
  read: ChildResult | string,
  timeout: number,
  output: string,
): Outcome {
  if (ending.kind === "stopped") return { status: "stopped", output };
  if (typeof read !== "string") {
    return read.status === "failed"
      ? { status: "failed", error: read.error, output }
      : { status: "ok", result: read, output };
  }
  return noResult(`${howItEnded(ending, timeout)}: ${read}`, output);
}

/** A failure in phase `child`, which has no stack. */
function noResult(message: string, output: string): ChildFailed {
  return {
    status: "failed",
    error: { phase: "child", message, stack: null, teardownError: null },
    output,
  };
}

/** The timeout, the signal or the exit status (`unknown` when null) a failure message opens with. */
function howItEnded(ending: Exclude<Ending, { kind: "stopped" }>, timeout: number): string {
  if (ending.kind === "timeout") return `the child was killed after its ${timeout} ms timeout`;
  if (ending.signal !== null) return `the child was killed by ${ending.signal}`;
  return `the child exited with status ${ending.code ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Reads the result line a child wrote on file descriptor 3.
 *
 * @param written - Everything the child wrote on file descriptor 3.
 * @param mode - The mode of the child's request, whose result shape the line must have.
 * @returns The result, or what was wrong with what the child wrote.
 */
function readResult(written: string, mode: ChildRequest["mode"]): ChildResult | string {
  if (written === "") return "it wrote no result";
  if (!written.endsWith("\n")) return "its result line has no newline";
  const line = written.slice(0, -1);
  if (line.includes("\n")) {
    return `it wrote ${written.split("\n").length - 1} lines on file descriptor 3, not one`;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `its result line is not JSON: ${thrownMessage(error)}`;
  }
  if (isFailed(value)) return value;
  const answers = { list: isListed, measure: isMeasured, once: isRan }[mode];
  if (answers(value)) return value;
  return `its result line does not answer a ${mode} request: ${line.slice(0, QUOTED_LINE_CHARS)}`;
}

/** Whether `value` is an object whose every `keys` field is a number. */
function hasNumbers(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => typeof value[key] === "number");
}

/** Whether `value` holds a string `message` and a `stack` that is a string or `null`. */
function hasMessageAndStack(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value["message"] === "string" &&
    (value["stack"] === null || typeof value["stack"] === "string")
  );
}

function isFailed(value: unknown): value is Failed {
  if (!isRecord(value) || value["status"] !== "failed") return false;
  const { error } = value;
  return (
    hasMessageAndStack(error) &&
    typeof error["phase"] === "string" &&
    CHILD_PHASES.has(error["phase"]) &&
    (error["teardownError"] === null || hasMessageAndStack(error["teardownError"]))
  );
}

function isListedCase(value: unknown): value is ListedCase {
  return (
    isRecord(value) && typeof value["id"] === "string" && typeof value["setupPerCall"] === "boolean"
  );
}

function isListed(value: unknown): value is Listed {
  return (
    isRecord(value) &&
    value["status"] === "ok" &&
    Array.isArray(value["cases"]) &&
    value["cases"].every(isListedCase)
  );
}

function isMeasured(value: unknown): value is Measured {
  if (!isRecord(value) || value["status"] !== "ok") return false;
  const { stats, sampling, checks, gc } = value;
  return (
    hasNumbers(stats, STATISTICS) &&
    hasNumbers(sampling, SAMPLING_NUMBERS) &&
    typeof sampling["callsPerSampleFixed"] === "boolean" &&
    hasNumbers(checks, ["ratioToEmptyBody"]) &&
    (gc === null || hasNumbers(gc, GC_NUMBERS))
  );
}

/** Whether `value` is a once child's result: `status` `"ok"` and nothing else. */
function isRan(value: unknown): value is Ran {
  return isRecord(value) && value["status"] === "ok" && Object.keys(value).length === 1;
}
