/**
 * The parent side of a child: finding the runtimes children run on, and starting the child entry
 * on one of them to read back its result.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChildError,
  ChildPhase,
  ChildRequest,
  Failed,
  Listed,
  ListedCase,
  Measured,
  Ran,
} from "./child.js";
import type { GcDuringTiming } from "./measure/collections.js";
import type { SamplingReport, Statistics } from "./measure/measure.js";
import { type Runtime, runningRuntime } from "./measure/runtime.js";
import { ConfigError, failedWith } from "./options.js";
import { RESULT_FD } from "./result-fd.js";
import { isRecord, thrownMessage } from "./utils.js";

const THIS_FILE = fileURLToPath(import.meta.url);

/** The child entry beside this module, with its extension: `child.js` built, `child.ts` from source. */
const CHILD_ENTRY = join(dirname(THIS_FILE), `child${extname(THIS_FILE)}`);

/** How much of the child's stdout and stderr an outcome keeps, from the end. */
const OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * How long to wait for a spawned process's pipes to close once it exited. A process it started can
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

/** The mode of a child's request. */
type Mode = ChildRequest["mode"];

/** The result a child that succeeded gives, by the mode of its request. */
interface ResultByMode {
  readonly list: Listed;
  readonly measure: Measured;
  readonly once: Ran;
}

interface Succeeded<M extends Mode> extends Captured {
  readonly status: "ok";
  readonly result: ResultByMode[M];
}

interface ChildFailed extends Captured {
  readonly status: "failed";
  readonly error: ChildError;
}

interface Stopped extends Captured {
  readonly status: "stopped";
}

/**
 * How a child's call ended: the result its request's mode `M` asks for, a failure, or a stop the
 * caller asked for.
 */
export type Outcome<M extends Mode = Mode> = Succeeded<M> | ChildFailed | Stopped;

/**
 * How the child process ended: stopped by the caller's signal, killed at its `timeout` in
 * milliseconds, or exited on its own, with `code` `null` when a signal ended it and `signal` `null`
 * otherwise.
 */
type Ending =
  | { readonly kind: "stopped" }
  | { readonly kind: "timeout"; readonly timeout: number }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null };

/** How a spawned process ended, or the error that kept it from starting. */
type Ended = Ending | { readonly kind: "error"; readonly error: Error };

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
  warmupSampleCount: true,
  timingAttemptCount: true,
  timingMs: true,
};

const SAMPLING_NUMBERS = Object.keys(SAMPLING_NUMBER_KEYS);

/** Every key of {@link GcDuringTiming}: a key missing here fails to compile. */
const GC_NUMBER_KEYS: Readonly<Record<keyof GcDuringTiming, true>> = {
  collectionCount: true,
  durationMs: true,
  maxDurationMs: true,
  nodeMinorCollectionCount: true,
  nodeMajorCollectionCount: true,
};

const GC_NUMBERS = Object.keys(GC_NUMBER_KEYS);

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

/** How long a runtime lookup's version probe may run, and the stop signal that ends it. */
export type LookupOptions = Pick<StartOptions, "timeout" | "signal">;

/**
 * Finds the executable a runtime's children start on, and its version.
 *
 * The runtime the parent runs on is its own executable, with the version from `process.versions`.
 * The other one is looked up by name on `PATH` and probed with `--version`, which is killed at
 * `timeout` or when `signal` fires.
 *
 * @param runtime - The runtime to find.
 * @param options - How long the version probe may run, and the stop signal that kills it.
 * @returns The executable and the version it reports, without a leading `v`, or `undefined` when
 *   the stop signal killed the probe; a lookup with no stop signal always finds one.
 * @throws {@link ConfigError} When no executable for `runtime` is on `PATH`, or its probe exits
 *   non-zero, dies on a signal, runs past `timeout`, cannot be started or prints nothing.
 * @throws Error When `process.versions` holds no version for the runtime this process runs on.
 */
export function findRuntime(
  runtime: Runtime,
  options: LookupOptions & { readonly signal?: undefined },
): Promise<FoundRuntime>;
export function findRuntime(
  runtime: Runtime,
  options: LookupOptions,
): Promise<FoundRuntime | undefined>;
export async function findRuntime(
  runtime: Runtime,
  options: LookupOptions,
): Promise<FoundRuntime | undefined> {
  if (runtime === runningRuntime()) {
    const version = process.versions[runtime];
    if (version === undefined) throw new Error(`process.versions holds no ${runtime} version`);
    return { runtime, executable: process.execPath, version };
  }
  const executable = onPath(runtime);
  if (executable === undefined) throw new ConfigError(`no ${runtime} executable on PATH`);
  const version = await probeVersion(executable, options);
  return version === undefined ? undefined : { runtime, executable, version };
}

/**
 * Finds the first executable file named `name` in a `PATH` directory, in `PATH` order.
 *
 * @param name - The executable's name, without an extension.
 * @returns The executable's path, or `undefined` when no `PATH` directory holds one.
 */
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
 * @param options - How long the probe may run, and the stop signal that kills it.
 * @returns What it printed on stdout, trimmed and without a leading `v`, or `undefined` when the
 *   stop signal killed it.
 * @throws {@link ConfigError} When the probe cannot be started, exits non-zero, dies on a signal,
 *   runs past `timeout` or prints nothing.
 */
async function probeVersion(
  executable: string,
  options: LookupOptions,
): Promise<string | undefined> {
  const probe = spawn(executable, ["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let printed = "";
  probe.stdout.setEncoding("utf8").on("data", (text: string) => {
    printed += text;
  });
  const ended = await processEnded(probe, options);
  if (ended.kind === "error") throw failedWith(`cannot run ${executable} --version`, ended.error);
  if (ended.kind === "stopped") return undefined;
  if (ended.kind === "timeout" || ended.signal !== null || ended.code !== 0) {
    throw new ConfigError(howItEnded(`${executable} --version`, ended));
  }
  const version = printed.trim().replace(/^v/, "");
  if (version === "") throw new ConfigError(`${executable} --version printed nothing`);
  return version;
}

// ---------------------------------------------------------------------------
// Child process and output capture
// ---------------------------------------------------------------------------

/** Keeps the end of what a child prints, as the text each stream decodes to. */
class OutputTail {
  readonly #chunks: string[] = [];
  #bytes = 0;

  /** The last {@link OUTPUT_TAIL_BYTES} bytes kept, cut forward to a character boundary. */
  text(): string {
    const kept = Buffer.from(this.#chunks.join(""), "utf8");
    let start = Math.max(0, kept.length - OUTPUT_TAIL_BYTES);
    // A UTF-8 continuation byte is 0b10xxxxxx; the cut moves past the rest of a split character.
    while (start > 0 && ((kept[start] ?? 0) & 0xc0) === 0x80) start += 1;
    return kept.toString("utf8", start);
  }

  /**
   * Keeps what a stream decoded, dropping the oldest chunks that leave the tail.
   *
   * Dropping chunks only bounds the memory a loud child holds: {@link OutputTail.text} cuts to the
   * last {@link OUTPUT_TAIL_BYTES} bytes whether or not any chunk was dropped, so no output shows
   * the drop.
   *
   * @param text - What the stream decoded since the last call.
   */
  add(text: string): void {
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
 *   wrote stands however the child then ended, unless the caller's signal stopped it.
 * @throws Error What starting the process throws, such as an argument `spawn` rejects.
 */
export async function startChild<R extends ChildRequest>(
  runtime: FoundRuntime,
  request: R,
  options: StartOptions,
): Promise<Outcome<R["mode"]>> {
  const { child, tail, written } = spawnChild(runtime, request, options);
  const ended = await processEnded(child, options);
  if (ended.kind === "error") {
    return noResult(`could not start the child: ${ended.error.message}`, tail.text());
  }
  return outcomeOf(ended, readResult<R["mode"]>(written(), request.mode), tail.text());
}

/**
 * Waits for a spawned process to end, killing it at `timeout` or when `signal` fires.
 *
 * Once the process exited, its pipes get {@link CLOSE_GRACE_MS} to close before they are
 * destroyed, so a process it started that holds them open does not hold the wait.
 *
 * @param child - The process just spawned.
 * @param options - How long it may run, and the stop signal that kills it.
 * @returns How it ended, or the error that kept it from starting.
 */
async function processEnded(child: ChildProcess, options: LookupOptions): Promise<Ended> {
  const { timeout, signal } = options;
  return new Promise((resolve) => {
    let ending: Ending | undefined;
    let settled = false;
    const kill = (killed: Exclude<Ending, { kind: "exit" }>): void => {
      ending ??= killed;
      child.kill("SIGKILL");
    };
    const stop = (): void => {
      kill({ kind: "stopped" });
    };
    const timer = setTimeout(kill, timeout, { kind: "timeout", timeout });
    if (signal?.aborted === true) stop();
    signal?.addEventListener("abort", stop, { once: true });

    const disarm = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    const settle = (ended: Ended): void => {
      if (settled) return;
      settled = true;
      disarm();
      for (const stream of child.stdio) stream?.destroy();
      resolve(ended);
    };

    child.once("error", (error) => {
      settle({ kind: "error", error });
    });
    child.once("exit", (code, exitSignal) => {
      disarm();
      const ended = ending ?? { kind: "exit", code, signal: exitSignal };
      const grace = setTimeout(settle, CLOSE_GRACE_MS, ended);
      child.once("close", () => {
        clearTimeout(grace);
        settle(ended);
      });
    });
  });
}

/**
 * Builds the flags a child's runtime starts with, before the script it runs.
 *
 * @param runtime - The runtime the child starts on.
 * @param nodeImport - The module a Node child imports first, or `undefined` for none.
 * @returns `--expose-gc`, then `--import <nodeImport>` on Node when a module is given.
 */
export function childRuntimeFlags(runtime: Runtime, nodeImport: string | undefined): string[] {
  const imports = runtime === "node" && nodeImport !== undefined ? ["--import", nodeImport] : [];
  return ["--expose-gc", ...imports];
}

/** A child process just started, and what it prints and writes as it runs. */
interface StartedChild {
  readonly child: ChildProcess;
  readonly tail: OutputTail;
  /** Everything the child wrote on file descriptor {@link RESULT_FD} so far. */
  readonly written: () => string;
}

/**
 * Spawns `runtime` on the child entry, or on `options.entry`, with `request` as its argument.
 *
 * @param runtime - The runtime to start the child on.
 * @param request - What the child is asked to do.
 * @param options - The module a Node child imports first, and the file to start in place of the
 *   child entry.
 * @returns The process, the tail of its stdout and stderr, and a reader of its file descriptor
 *   {@link RESULT_FD}.
 * @throws Error What `spawn` throws for an argument it rejects.
 */
function spawnChild(
  runtime: FoundRuntime,
  request: ChildRequest,
  options: Pick<StartOptions, "nodeImport" | "entry">,
): StartedChild {
  const { nodeImport, entry = CHILD_ENTRY } = options;
  const child = spawn(
    runtime.executable,
    [...childRuntimeFlags(runtime.runtime, nodeImport), entry, JSON.stringify(request)],
    {
      // `stdio` is positional: descriptor RESULT_FD exists in the child only when every slot
      // below it is filled, so the slots between stderr and the result's are pipes too.
      stdio: ["ignore", ...Array.from({ length: RESULT_FD }, () => "pipe" as const)],
      windowsHide: true,
    },
  );
  const tail = new OutputTail();
  // Each stream decodes on its own, so a character split across chunks stays whole.
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8").on("data", (text: string) => {
      tail.add(text);
    });
  }
  const resultChunks: Buffer[] = [];
  child.stdio[RESULT_FD]?.on("data", (chunk: Buffer) => {
    resultChunks.push(chunk);
  });
  return { child, tail, written: () => Buffer.concat(resultChunks).toString("utf8") };
}

/**
 * Builds the outcome of a child that ended.
 *
 * @param ending - How the child ended.
 * @param read - The result the child wrote, or what was wrong with what it wrote.
 * @param output - The tail of the child's stdout and stderr.
 * @returns A stop when the caller stopped the child; otherwise the result or the child's own
 *   failure when it wrote one, or a failure in phase `child` saying how it ended.
 */
function outcomeOf<M extends Mode>(
  ending: Ending,
  read: ResultByMode[M] | Failed | string,
  output: string,
): Outcome<M> {
  if (ending.kind === "stopped") return { status: "stopped", output };
  if (typeof read !== "string") {
    return isFailed(read)
      ? { status: "failed", error: read.error, output }
      : { status: "ok", result: read, output };
  }
  return noResult(`${howItEnded("the child", ending)}: ${read}`, output);
}

/** An outcome that failed in phase `child`, which has no stack, with the child's output tail. */
function noResult(message: string, output: string): ChildFailed {
  return {
    status: "failed",
    error: { phase: "child", message, stack: null, teardownError: null },
    output,
  };
}

/**
 * Says how a process that did not end cleanly ended, for the start of a failure message.
 *
 * @param subject - What ran, as the sentence's subject, such as `the child`.
 * @param ending - How it ended: at its timeout, or on its own.
 * @returns `<subject> was killed after its <timeout> ms timeout`, `<subject> was killed by
 *   <signal>`, or `<subject> exited with status <code>`, with `unknown` for a null code.
 */
export function howItEnded(subject: string, ending: Exclude<Ending, { kind: "stopped" }>): string {
  if (ending.kind === "timeout") {
    return `${subject} was killed after its ${ending.timeout} ms timeout`;
  }
  if (ending.signal !== null) return `${subject} was killed by ${ending.signal}`;
  return `${subject} exited with status ${ending.code ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Reads the result line a child wrote on file descriptor {@link RESULT_FD}.
 *
 * @param written - Everything the child wrote on file descriptor {@link RESULT_FD}.
 * @param mode - The mode of the child's request, whose result shape the line must have.
 * @returns The result, or what was wrong with what the child wrote.
 */
function readResult<M extends Mode>(written: string, mode: M): ResultByMode[M] | Failed | string {
  if (written === "") return "it wrote no result";
  if (!written.endsWith("\n")) return "its result line has no newline";
  const line = written.slice(0, -1);
  if (line.includes("\n")) {
    return `it wrote ${written.split("\n").length - 1} lines on file descriptor ${RESULT_FD}, not one`;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `its result line is not JSON: ${thrownMessage(error)}`;
  }
  if (isFailed(value)) return value;
  const answers: { readonly [K in Mode]: (value: unknown) => value is ResultByMode[K] } = {
    list: isListed,
    measure: isMeasured,
    once: isRan,
  };
  const answer = answers[mode];
  if (answer(value)) return value;
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
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["setupPerCall"] === "boolean" &&
    typeof value["name"] === "string" &&
    (typeof value["contender"] === "string" || value["contender"] === null)
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
  if (!isRecord(value) || value["status"] !== "ok" || !isRecord(value["time"])) return false;
  const { stats, sampling, checks, gc, rawSamples } = value["time"];
  return (
    rawSamples === null &&
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
