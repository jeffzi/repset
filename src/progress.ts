/**
 * What the command shows on stderr as each child starts: a live line on a terminal, one line per
 * child elsewhere.
 */
import type { Output } from "./command.js";
import { paint } from "./table.js";

/** The frames of the live line's indicator, one per tick. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How long each indicator frame shows, in milliseconds. */
const FRAME_MS = 80;

/** Splits the live line into the characters a person sees, so a cut never splits one. */
const GRAPHEMES = new Intl.Segmenter();

/** The characters a terminal draws two columns wide: East Asian wide and full-width ones, and emoji. */
const WIDE =
  /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFF}]/u;

/** Moves the cursor to the start of its row and erases the row. */
const CLEAR_ROW = "\r\x1b[2K";

/** What the command shows on stderr as each child starts. */
export interface Progress {
  /** Starts counting the children of a phase that starts `total` of them. */
  planned(total: number): void;
  /** Lowers the phase's total by `count` children that will no longer start, keeping its started count. */
  dropped(count: number): void;
  /** Shows that the phase's next child starts, doing what `text` says. */
  starting(text: string): void;
  /** Stops the indicator and erases the live line; calling it again does nothing. */
  stop(): void;
}

/** Progress as one line per child, with no count, animation or cursor control. */
function linePerChild(stderr: Output): Progress {
  return {
    planned: () => undefined,
    dropped: () => undefined,
    starting: (text) => {
      stderr.write(`${text}\n`);
    },
    stop: () => undefined,
  };
}

/**
 * Progress as one live line on a terminal: `[i/n]`, then what the running child does, behind an
 * animated indicator. The line is cut to the terminal's width, so erasing its row erases all of it.
 * The indicator's timer is unreferenced: it never keeps the process alive.
 *
 * @param stderr - The terminal the line shows on.
 * @param color - Whether `stderr` shows color, which colors the indicator.
 * @returns The progress, showing nothing until the first child starts.
 */
function liveLine(stderr: Output, color: boolean): Progress {
  let total = 0;
  let started = 0;
  let doing = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = (): void => {
    // The last column stays empty: a row filled to it wraps on some terminals.
    let room = (stderr.columns ?? Number.POSITIVE_INFINITY) - 1;
    const kept: string[] = [];
    for (const { segment } of GRAPHEMES.segment(
      `${FRAMES[frame]} [${started}/${total}] ${doing}`,
    )) {
      room -= WIDE.test(segment) ? 2 : 1;
      if (room < 0) break;
      kept.push(segment);
    }
    const [indicator = "", ...rest] = kept;
    stderr.write(`${CLEAR_ROW}${paint("green", indicator, color)}${rest.join("")}`);
  };
  return {
    planned: (count) => {
      total = count;
      started = 0;
    },
    dropped: (count) => {
      total -= count;
    },
    starting: (text) => {
      started += 1;
      doing = text;
      timer ??= setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        draw();
      }, FRAME_MS).unref();
      draw();
    },
    stop: () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      stderr.write(CLEAR_ROW);
    },
  };
}

/** A live line on a terminal stderr whose `TERM` is not `dumb`, one line per child elsewhere. */
export function progressOn(stderr: Output, color: boolean): Progress {
  const live = stderr.isTTY === true && process.env["TERM"] !== "dumb";
  return live ? liveLine(stderr, color) : linePerChild(stderr);
}
