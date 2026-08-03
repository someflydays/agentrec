import type { CastEvent } from "@agent-blackbox/core/browser";

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
