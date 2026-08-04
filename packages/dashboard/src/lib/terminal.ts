import type { Cast, CastEvent } from "@agentrec/core/browser";
import type { ITheme, Terminal } from "@xterm/xterm";
import { CastIndex, type TerminalOp } from "./cast";

export const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Advance width per font size for the mono stack; cell height at lineHeight 1. */
const CHAR_ADVANCE_RATIO = 0.602;
const LINE_HEIGHT_RATIO = 1.22;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 15;

/**
 * The recording's geometry is authoritative — a replay must not reflow the
 * agent's output — so the pane scales the font instead of resizing the grid.
 */
export function fitFontSize(width: number, height: number, cols: number, rows: number): number {
  if (cols < 1 || rows < 1 || width < 1 || height < 1) return MAX_FONT_SIZE;
  const byWidth = width / (cols * CHAR_ADVANCE_RATIO);
  const byHeight = height / (rows * LINE_HEIGHT_RATIO);
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(Math.min(byWidth, byHeight))));
}

/**
 * Bytes allowed inside xterm's write buffer at once. Everything past this waits
 * in our own queue, where a seek can still throw it away.
 */
const WRITE_WINDOW = 1024 * 1024;

/**
 * Drives one terminal from a recording.
 *
 * xterm parses writes asynchronously while `reset()` and `resize()` take effect
 * immediately, so handing it a seek while an earlier one is still parsing
 * scrambles the screen. Every op therefore goes through one queue: writes are
 * fed a window at a time and grid changes wait for the window to drain.
 *
 * `to()` supersedes any earlier request rather than queueing behind it. Ops
 * already inside xterm cannot be recalled, so the new plan is not built until
 * they land — by then `applied` is the truth again, and the plan is computed
 * against it. That is what keeps a fast scrub from piling up a session's worth
 * of parsing: intermediate positions are simply dropped.
 */
export class CastPlayer {
  private readonly term: Terminal;
  private readonly index: CastIndex;
  private readonly onResize: () => void;
  private queue: TerminalOp[] = [];
  /** Requested virtual time that still needs a plan. */
  private pending: number | null = null;
  /** Events the screen actually reflects. */
  private applied = 0;
  private inFlight = 0;
  private inFlightBytes = 0;
  private draining = false;
  private disposed = false;

  constructor(term: Terminal, cast: Cast, onResize: () => void) {
    this.term = term;
    this.index = CastIndex.from(cast);
    this.onResize = onResize;
  }

  get duration(): number {
    return this.index.duration;
  }

  /** Appends a frame from a live session; does not paint it. */
  append(event: CastEvent): void {
    this.index.append(event);
  }

  /** Paints the screen as of virtual time `t`, replacing any pending request. */
  to(t: number): void {
    if (this.disposed) return;
    this.pending = Math.max(0, t);
    this.queue.length = 0;
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.queue.length = 0;
  }

  private pump(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      for (;;) {
        const op = this.queue[0];
        if (op === undefined) {
          if (this.pending === null || this.inFlight > 0) break;
          const plan = this.index.plan(this.pending, this.applied);
          this.pending = null;
          if (plan.ops.length === 0) break;
          this.queue = plan.ops;
          continue;
        }
        if (op.kind !== "write") {
          // Ordering: the screen must be quiet before the grid changes under it.
          if (this.inFlight > 0) break;
          this.queue.shift();
          this.applySync(op);
          continue;
        }
        // Always keep one write moving, even if it alone exceeds the window.
        if (this.inFlight > 0 && this.inFlightBytes >= WRITE_WINDOW) break;
        this.queue.shift();
        this.start(op);
      }
    } finally {
      this.draining = false;
    }
  }

  private applySync(op: TerminalOp): void {
    if (op.kind === "reset") {
      this.term.reset();
      this.applied = 0;
      return;
    }
    if (op.kind !== "resize") return;
    if (op.cols !== this.term.cols || op.rows !== this.term.rows) {
      this.term.resize(op.cols, op.rows);
      this.onResize();
    }
    this.applied = op.at;
  }

  private start(op: TerminalOp): void {
    if (op.kind !== "write") return;
    const size = op.data.length;
    this.inFlight += 1;
    this.inFlightBytes += size;
    this.term.write(op.data, () => {
      this.inFlight -= 1;
      this.inFlightBytes -= size;
      // The op landed even if its plan was abandoned, so the screen moved with it.
      this.applied = op.at;
      this.pump();
    });
  }
}

export const TERMINAL_THEME: ITheme = {
  background: "#08090b",
  foreground: "#d5d9de",
  cursor: "#ff8a3d",
  cursorAccent: "#08090b",
  selectionBackground: "#2b3138",
  black: "#15181c",
  red: "#ff5f56",
  green: "#4ec9a5",
  yellow: "#e3b341",
  blue: "#6aa9f4",
  magenta: "#c78ef0",
  cyan: "#4ec9d4",
  white: "#c8ced5",
  brightBlack: "#5d666f",
  brightRed: "#ff8078",
  brightGreen: "#6fdcbc",
  brightYellow: "#f0c96a",
  brightBlue: "#8fc0ff",
  brightMagenta: "#d7abf7",
  brightCyan: "#7adde6",
  brightWhite: "#f2f5f7",
};
