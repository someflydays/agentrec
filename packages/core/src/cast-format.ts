/**
 * Terminal recordings use the asciinema v2 format (asciicast): a JSON header
 * line followed by one JSON array per event. Sessions stay playable with
 * standard asciinema tooling, not just our dashboard.
 *
 * This module is environment-agnostic (used by the browser dashboard);
 * CastWriter lives in cast.ts because it needs the filesystem.
 */
export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
  env?: Record<string, string>;
}

export interface CastEvent {
  /** Seconds since recording start. */
  t: number;
  code: "o" | "i" | "r" | "m";
  data: string;
}

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
}

/** Tolerant parser: malformed lines are skipped, matching SessionStore.readEvents. */
export function parseCast(text: string): Cast {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error("empty cast file");
  }
  const header = JSON.parse(headerLine) as CastHeader;
  if (header.version !== 2) {
    throw new Error(`unsupported cast version: ${String(header.version)}`);
  }
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as [number, CastEvent["code"], string];
      if (typeof parsed[0] === "number" && typeof parsed[2] === "string") {
        events.push({ t: parsed[0], code: parsed[1], data: parsed[2] });
      }
    } catch {
      // torn write — skip
    }
  }
  return { header, events };
}
