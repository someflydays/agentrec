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
