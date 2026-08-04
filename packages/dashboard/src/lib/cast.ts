import type { Cast, CastEvent } from "@agentrec/core/browser";

export function castDuration(events: readonly CastEvent[]): number {
  const last = events[events.length - 1];
  return last === undefined ? 0 : last.t;
}

/** Resize payloads are "COLSxROWS" in asciicast v2. */
export function parseResize(data: string): { cols: number; rows: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(data.trim());
  if (match === null) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/** Parses one raw asciicast event line as delivered over SSE. */
export function parseCastLine(line: string): CastEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const [t, code, data] = parsed as unknown[];
  if (typeof t !== "number" || typeof data !== "string") return null;
  if (code !== "o" && code !== "i" && code !== "r" && code !== "m") return null;
  return { t, code, data };
}

/** Output events between checkpoints. */
const CHECKPOINT_EVENTS = 64;
/** Output bytes between checkpoints, for recordings with large frames. */
const CHECKPOINT_BYTES = 256 * 1024;
/**
 * Output bytes per write op. Small enough that a superseded seek is not stuck
 * waiting on one, large enough that a long replay is not paying a scheduling
 * round trip every few frames.
 */
const WRITE_CHUNK = 256 * 1024;

/**
 * A point the screen can be rebuilt from without replaying the whole session.
 * Its "snapshot" is `output.slice(0, end)` — see CastIndex for why the payload
 * is an offset instead of a string of its own.
 */
interface Checkpoint {
  /** Index of the first event *after* the checkpoint. */
  index: number;
  /** Virtual time it closed at, in seconds. */
  t: number;
  /** Length of the accumulated output at this point. */
  end: number;
  /** Grid the recording had reached here. */
  cols: number;
  rows: number;
}

/**
 * One step of a replay. `at` is how many events the terminal has consumed once
 * the op lands, which is what lets a cancelled plan still know where the screen
 * really is: ops apply in order, so the last one that completed is the truth.
 */
export type TerminalOp =
  | { kind: "reset"; at: number }
  | { kind: "resize"; at: number; cols: number; rows: number }
  | { kind: "write"; at: number; data: string };

export interface SeekPlan {
  /** Event index the terminal has consumed once every op is applied. */
  index: number;
  ops: TerminalOp[];
}

/**
 * Random access over a recording.
 *
 * Seeking naively means resetting the terminal and rewriting every byte before
 * the target, which is O(session) per seek and unusable while scrubbing. This
 * keeps periodic checkpoints instead: a backward seek restores from the nearest
 * one, and a forward seek replays only the events in between — no reset, no
 * prefix.
 *
 * A checkpoint's snapshot is an offset into one accumulated copy of the
 * recording's output rather than a string of its own, so k checkpoints cost
 * O(k) numbers instead of O(k × session) characters. That single copy (a few MB
 * on a long session, alongside the events it was built from) is the memory
 * tradeoff, and it is what makes the restore payload free to cut.
 *
 * Grid changes land on their own checkpoint, so a restore replays each stretch
 * of output under the geometry it was recorded with.
 */
export class CastIndex {
  private readonly events: CastEvent[] = [];
  private readonly checkpoints: Checkpoint[];
  private output = "";
  private cols: number;
  private rows: number;
  private readonly startCols: number;
  private readonly startRows: number;
  private sinceEvents = 0;
  private sinceBytes = 0;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.startCols = cols;
    this.startRows = rows;
    this.checkpoints = [{ index: 0, t: 0, end: 0, cols, rows }];
  }

  static from(cast: Cast): CastIndex {
    const index = new CastIndex(cast.header.width, cast.header.height);
    for (const event of cast.events) index.append(event);
    return index;
  }

  get length(): number {
    return this.events.length;
  }

  get duration(): number {
    return castDuration(this.events);
  }

  /** Characters of recorded output held for checkpoint restores. */
  get outputLength(): number {
    return this.output.length;
  }

  get checkpointCount(): number {
    return this.checkpoints.length;
  }

  append(event: CastEvent): void {
    this.events.push(event);
    if (event.code === "o") {
      this.output += event.data;
      this.sinceEvents += 1;
      this.sinceBytes += event.data.length;
      if (this.sinceEvents >= CHECKPOINT_EVENTS || this.sinceBytes >= CHECKPOINT_BYTES) {
        this.mark(event.t);
      }
      return;
    }
    if (event.code !== "r") return;
    const size = parseResize(event.data);
    if (size === null) return;
    this.cols = size.cols;
    this.rows = size.rows;
    this.mark(event.t);
  }

  /** Index of the first event past virtual time `t`. */
  indexAfter(t: number): number {
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const event = this.events[mid];
      if (event !== undefined && event.t <= t) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /**
   * How to get the screen to virtual time `t` given that it currently reflects
   * `applied` events.
   */
  plan(t: number, applied: number): SeekPlan {
    const index = this.indexAfter(t);
    if (index >= applied) return { index, ops: this.advance(applied, index) };
    const at = this.checkpointBefore(index);
    const checkpoint = this.checkpoints[at];
    if (checkpoint === undefined) return { index, ops: this.advance(0, index) };
    return { index, ops: [...this.restore(at), ...this.advance(checkpoint.index, index)] };
  }

  private mark(t: number): void {
    this.checkpoints.push({
      index: this.events.length,
      t,
      end: this.output.length,
      cols: this.cols,
      rows: this.rows,
    });
    this.sinceEvents = 0;
    this.sinceBytes = 0;
  }

  /**
   * Ops that rebuild the screen as of checkpoint `at`, from a blank terminal.
   * The snapshot goes in as slices of the accumulated output rather than one
   * write, so a scrub that supersedes this restore only has to wait out the
   * slice already inside xterm. Runs are cut on checkpoint boundaries, which
   * keeps every op's `at` an event index the screen can honestly claim.
   */
  private restore(at: number): TerminalOp[] {
    const ops: TerminalOp[] = [
      { kind: "reset", at: 0 },
      { kind: "resize", at: 0, cols: this.startCols, rows: this.startRows },
    ];
    let cols = this.startCols;
    let rows = this.startRows;
    let start = 0;
    let end = 0;
    let endAt = 0;
    const flush = (): void => {
      if (end <= start) return;
      ops.push({ kind: "write", at: endAt, data: this.output.slice(start, end) });
      start = end;
    };
    for (let i = 1; i <= at; i += 1) {
      const checkpoint = this.checkpoints[i];
      if (checkpoint === undefined) break;
      if (checkpoint.cols !== cols || checkpoint.rows !== rows) {
        flush();
        cols = checkpoint.cols;
        rows = checkpoint.rows;
        // A grid change closes its own checkpoint, so the segment it opens is
        // exactly the output recorded at that size.
        ops.push({ kind: "resize", at: checkpoint.index, cols, rows });
      }
      end = checkpoint.end;
      endAt = checkpoint.index;
      if (end - start >= WRITE_CHUNK) flush();
    }
    flush();
    return ops;
  }

  /** Ops that carry a screen holding `from` events forward to `to` events. */
  private advance(from: number, to: number): TerminalOp[] {
    const ops: TerminalOp[] = [];
    let chunk = "";
    const flush = (at: number): void => {
      if (chunk.length === 0) return;
      ops.push({ kind: "write", at, data: chunk });
      chunk = "";
    };
    for (let i = Math.max(0, from); i < to; i += 1) {
      const event = this.events[i];
      if (event === undefined) break;
      if (event.code === "o") {
        chunk += event.data;
        if (chunk.length >= WRITE_CHUNK) flush(i + 1);
        continue;
      }
      if (event.code !== "r") continue;
      const size = parseResize(event.data);
      if (size === null) continue;
      flush(i);
      ops.push({ kind: "resize", at: i + 1, cols: size.cols, rows: size.rows });
    }
    flush(to);
    return ops;
  }

  /** Last checkpoint at or before `index`; checkpoint 0 is always a valid answer. */
  private checkpointBefore(index: number): number {
    let low = 0;
    let high = this.checkpoints.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      const checkpoint = this.checkpoints[mid];
      if (checkpoint !== undefined && checkpoint.index <= index) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}
