import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/** A timer resolution fine enough that 100 ms samples span far more than 200 times the resolution. */
export const FINE_RESOLUTION = 2 ** -10;

/** A timer resolution coarse enough that short samples span few multiples of the resolution or none. */
export const COARSE_RESOLUTION = 2 ** -4;

/** A state a recorded lifecycle builds, named by how many states were built before it. */
export interface RecordedWorld {
  readonly id: number;
}

/** The call, counted from zero per callback, at which each callback throws. */
export interface Failures {
  readonly setup?: number | undefined;
  readonly fn?: number | undefined;
  readonly teardown?: number | undefined;
}

export interface LifecycleOptions {
  /** The call at which each callback throws; none throws when omitted. */
  readonly failAt?: Failures;
  /** The value each callback throws at its failing call. */
  readonly thrown: { readonly setup: unknown; readonly fn: unknown; readonly teardown: unknown };
  /** The state setup builds for build `id`; `{ id }` when omitted. */
  readonly world?: (id: number) => RecordedWorld;
  /** Runs at the start of every callback call, a failing one included. */
  readonly onCall?: () => void;
  /** Runs after a setup call that built its state. */
  readonly afterSetup?: () => void;
  /** Runs after a body call that did not throw; what it returns, the body returns. */
  readonly afterFn?: () => unknown;
  /** Runs after a teardown call that released its state, given the call's index; what it returns, teardown returns. */
  readonly afterTeardown?: (call: number) => unknown;
}

export interface RecordedLifecycle {
  readonly setup: () => RecordedWorld;
  readonly fn: (world: RecordedWorld) => unknown;
  readonly teardown: (world: RecordedWorld) => unknown;
  /** One entry per call that got past its throw check, `"<callback> <id>"`, body calls logged before it. */
  readonly log: string[];
  /** The states built and not yet torn down. */
  readonly live: Set<RecordedWorld>;
  /** Every state setup built, in build order. */
  readonly built: RecordedWorld[];
}

/**
 * Builds a setup, body and teardown that log their calls and track the states alive, each throwing
 * its given value at its given call.
 *
 * Setup throws before it builds, the body after it logs, and teardown before it releases.
 *
 * @param options - Which calls throw and what, how a state is built, and the hooks that charge a
 *   clock or pick the body's and teardown's return values.
 * @returns The lifecycle and the records the tests read.
 */
export function recordedLifecycle(options: LifecycleOptions): RecordedLifecycle {
  const { failAt = {}, thrown, world = (id) => ({ id }), onCall = () => undefined } = options;
  const log: string[] = [];
  const live = new Set<RecordedWorld>();
  const built: RecordedWorld[] = [];
  let setupCalls = 0;
  let bodyCalls = 0;
  let teardownCalls = 0;
  return {
    setup: () => {
      onCall();
      const call = setupCalls;
      setupCalls += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- the test names the value, Error or not
      if (call === failAt.setup) throw thrown.setup;
      const state = world(built.length);
      built.push(state);
      live.add(state);
      log.push(`setup ${state.id}`);
      options.afterSetup?.();
      return state;
    },
    fn: (state) => {
      onCall();
      log.push(`fn ${state.id}`);
      const call = bodyCalls;
      bodyCalls += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- the test names the value, Error or not
      if (call === failAt.fn) throw thrown.fn;
      return options.afterFn?.();
    },
    teardown: (state) => {
      onCall();
      const call = teardownCalls;
      teardownCalls += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- the test names the value, Error or not
      if (call === failAt.teardown) throw thrown.teardown;
      live.delete(state);
      log.push(`teardown ${state.id}`);
      return options.afterTeardown?.(call);
    },
    log,
    live,
    built,
  };
}

/**
 * Exposes V8's garbage collector by enabling the `--expose-gc` flag for the whole process.
 *
 * @returns A function that runs a major garbage collection when called.
 * @throws {Error} When V8 exposes no `gc` function after the flag is set.
 */
export function enabledGc(): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 exposed no gc function");
  return () => {
    Reflect.apply(gc, undefined, []);
  };
}
