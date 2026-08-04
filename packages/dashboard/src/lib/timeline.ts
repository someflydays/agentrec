import type { SessionEvent } from "@agentrec/core/browser";

export interface PromptRow {
  kind: "prompt";
  key: string;
  t: number;
  text: string;
}

export interface AssistantRow {
  kind: "assistant";
  key: string;
  t: number;
  text: string;
  model?: string;
}

export interface ToolRow {
  kind: "tool";
  key: string;
  t: number;
  name: string;
  input: unknown;
  output?: string;
  ok?: boolean;
  durationMs?: number;
}

export interface FileRow {
  kind: "file";
  key: string;
  t: number;
  path: string;
  change: "create" | "edit";
  diff?: string;
}

export interface NoticeRow {
  kind: "notice";
  key: string;
  t: number;
  label: string;
  message: string;
  level: "info" | "error";
}

export interface TurnRow {
  kind: "turn";
  key: string;
  t: number;
}

export type TimelineRow = PromptRow | AssistantRow | ToolRow | FileRow | NoticeRow | TurnRow;

export const FILTER_KINDS = ["prompt", "assistant", "tool", "file"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

export const FILTER_LABELS: Readonly<Record<FilterKind, string>> = {
  prompt: "Prompts",
  assistant: "Assistant",
  tool: "Tools",
  file: "Files",
};

export function isFilterKind(kind: TimelineRow["kind"]): kind is FilterKind {
  return kind === "prompt" || kind === "assistant" || kind === "tool" || kind === "file";
}

/**
 * Flattens the event log into display rows, folding each tool.end into the row
 * its tool.start created. Pairing prefers toolUseId; recorders that omit it get
 * FIFO-by-name, which matches the order a single agent turn issues calls in.
 */
export function buildTimeline(events: SessionEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const openById = new Map<string, ToolRow>();
  const openByName = new Map<string, ToolRow[]>();

  for (const event of events) {
    const key = String(event.seq);
    switch (event.type) {
      case "prompt":
        rows.push({ kind: "prompt", key, t: event.t, text: event.data.text });
        break;
      case "assistant.text":
        rows.push({
          kind: "assistant",
          key,
          t: event.t,
          text: event.data.text,
          ...(event.data.model !== undefined ? { model: event.data.model } : {}),
        });
        break;
      case "tool.start": {
        const row: ToolRow = {
          kind: "tool",
          key,
          t: event.t,
          name: event.data.name,
          input: event.data.input,
        };
        rows.push(row);
        if (event.data.toolUseId !== undefined) openById.set(event.data.toolUseId, row);
        const queue = openByName.get(event.data.name);
        if (queue === undefined) openByName.set(event.data.name, [row]);
        else queue.push(row);
        break;
      }
      case "tool.end": {
        const row = takeOpenTool(openById, openByName, event.data.name, event.data.toolUseId);
        if (row === null) break;
        row.ok = event.data.ok;
        row.durationMs = Math.max(0, event.t - row.t);
        if (event.data.output !== undefined) row.output = event.data.output;
        break;
      }
      case "file.change":
        rows.push({
          kind: "file",
          key,
          t: event.t,
          path: event.data.path,
          change: event.data.kind,
          ...(event.data.diff !== undefined ? { diff: event.data.diff } : {}),
        });
        break;
      case "notification":
        rows.push({
          kind: "notice",
          key,
          t: event.t,
          label: "notice",
          message: event.data.message,
          level: "info",
        });
        break;
      case "recorder.error":
        rows.push({
          kind: "notice",
          key,
          t: event.t,
          label: `recorder: ${event.data.source}`,
          message: event.data.message,
          level: "error",
        });
        break;
      case "turn.end":
        rows.push({ kind: "turn", key, t: event.t });
        break;
      default:
        break;
    }
  }

  return rows;
}

export function fileRows(rows: TimelineRow[]): FileRow[] {
  return rows.filter((row): row is FileRow => row.kind === "file");
}

/** Rows kept mounted beyond each edge of the viewport. */
const OVERSCAN = 10;

/** First guess per kind, until measured rows of that kind say otherwise. */
const ESTIMATES: Readonly<Record<TimelineRow["kind"], number>> = {
  prompt: 58,
  assistant: 58,
  tool: 33,
  file: 33,
  notice: 33,
  turn: 29,
};

export interface RowWindow {
  /** First row to mount. */
  start: number;
  /** One past the last row to mount. */
  end: number;
  /** Spacer height standing in for the rows before `start`. */
  padTop: number;
  /** Spacer height standing in for the rows after `end`. */
  padBottom: number;
  total: number;
}

/**
 * Where every timeline row sits, so only the ones on screen have to exist.
 *
 * Rows are not a fixed height — a prompt wraps, an expanded tool row grows by
 * an order of magnitude — so heights come from measuring what is mounted and
 * everything else is estimated from the running average of its kind. Offsets
 * are a prefix sum rebuilt from the first row that moved, which is what makes a
 * re-filter or an expansion cheap.
 */
export class RowPositions {
  private rows: readonly TimelineRow[] = [];
  private readonly heights = new Map<string, number>();
  private readonly samples = new Map<TimelineRow["kind"], { sum: number; count: number }>();
  private indexes: Map<string, number> | null = null;
  private offsets: number[] = [0];
  private dirtyFrom = 0;

  /** Points the cache at `rows`, invalidating from the first row that changed. */
  sync(rows: readonly TimelineRow[]): void {
    if (rows === this.rows) return;
    const shared = Math.min(this.rows.length, rows.length);
    let first = shared;
    for (let i = 0; i < shared; i += 1) {
      if (this.rows[i]?.key !== rows[i]?.key) {
        first = i;
        break;
      }
    }
    this.rows = rows;
    this.indexes = null;
    this.invalidate(first);
  }

  /**
   * Records a mounted row's height. Expanded rows are measured but kept out of
   * the estimates: one open tool row would otherwise make every unseen row of
   * its kind look ten times taller than it is.
   */
  measure(key: string, height: number, expanded: boolean): boolean {
    const previous = this.heights.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return false;
    this.heights.set(key, height);
    const index = this.indexOf(key);
    const kind = this.rows[index]?.kind;
    if (kind !== undefined && !expanded) {
      const sample = this.samples.get(kind) ?? { sum: 0, count: 0 };
      sample.sum += height - (previous ?? 0);
      if (previous === undefined) sample.count += 1;
      this.samples.set(kind, sample);
    }
    if (index >= 0) this.invalidate(index);
    return true;
  }

  /** Drops every measurement; the pane got a new width, so nothing still holds. */
  forget(): void {
    this.heights.clear();
    this.samples.clear();
    this.invalidate(0);
  }

  indexOf(key: string): number {
    if (this.indexes === null) {
      this.indexes = new Map(this.rows.map((row, index) => [row.key, index]));
    }
    return this.indexes.get(key) ?? -1;
  }

  offsetOf(index: number): number {
    this.build();
    return this.offsets[Math.max(0, Math.min(index, this.rows.length))] ?? 0;
  }

  heightOf(index: number): number {
    const row = this.rows[index];
    return row === undefined ? 0 : this.heightFor(row);
  }

  windowFor(scrollTop: number, viewportHeight: number): RowWindow {
    this.build();
    const count = this.rows.length;
    const total = this.offsets[count] ?? 0;
    if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 };
    const top = Math.max(0, scrollTop);
    const start = Math.max(0, this.rowAt(top) - OVERSCAN);
    const end = Math.min(count, this.rowAt(top + Math.max(0, viewportHeight)) + 1 + OVERSCAN);
    return {
      start,
      end,
      padTop: this.offsets[start] ?? 0,
      padBottom: total - (this.offsets[end] ?? total),
      total,
    };
  }

  private invalidate(index: number): void {
    if (index < this.dirtyFrom) this.dirtyFrom = Math.max(0, index);
  }

  private build(): void {
    const count = this.rows.length;
    const from = Math.min(this.dirtyFrom, count);
    if (from >= count && this.offsets.length === count + 1) return;
    this.offsets.length = count + 1;
    let offset = this.offsets[from] ?? 0;
    for (let i = from; i < count; i += 1) {
      this.offsets[i] = offset;
      const row = this.rows[i];
      offset += row === undefined ? 0 : this.heightFor(row);
    }
    this.offsets[count] = offset;
    this.dirtyFrom = count;
  }

  private heightFor(row: TimelineRow): number {
    const measured = this.heights.get(row.key);
    if (measured !== undefined) return measured;
    const sample = this.samples.get(row.kind);
    if (sample === undefined || sample.count === 0) return ESTIMATES[row.kind];
    return sample.sum / sample.count;
  }

  /** Last row starting at or before `offset`. */
  private rowAt(offset: number): number {
    let low = 0;
    let high = this.rows.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if ((this.offsets[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return Math.max(0, low);
  }
}

function takeOpenTool(
  openById: Map<string, ToolRow>,
  openByName: Map<string, ToolRow[]>,
  name: string,
  toolUseId: string | undefined,
): ToolRow | null {
  const queue = openByName.get(name);
  if (toolUseId !== undefined) {
    const byId = openById.get(toolUseId);
    if (byId !== undefined) {
      openById.delete(toolUseId);
      if (queue !== undefined) {
        const index = queue.indexOf(byId);
        if (index >= 0) queue.splice(index, 1);
      }
      return byId;
    }
  }
  const next = queue?.shift();
  return next ?? null;
}
