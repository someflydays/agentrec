import type { SessionEventType } from "./types.js";

/**
 * The parts of search that a browser can use: result shapes and the snippet
 * delimiters. The index itself needs node:fs and node:sqlite, so it lives in
 * search.ts — the same split as cast.ts and cast-format.ts.
 */

/** Delimiters around matched terms in a snippet; control codes never collide with indexed text. */
export const MATCH_OPEN = "";
export const MATCH_CLOSE = "";

export interface SearchResult {
  sessionId: string;
  sessionTitle?: string;
  sessionStartedAt: string;
  seq: number;
  type: SessionEventType;
  /** Milliseconds since the session started, mirroring SessionEvent.t. */
  t: number;
  /** Matched terms wrapped in MATCH_OPEN/MATCH_CLOSE. */
  snippet: string;
  /** FTS5 bm25 score; more negative is a better match. */
  score: number;
}

export interface SearchOptions {
  /** Maximum hits to return. Default 20. */
  limit?: number;
  /** Restrict to one session id (exact, not a prefix). */
  sessionId?: string;
  /** Restrict to these event types. */
  types?: SessionEventType[];
  /** Pass the query to FTS5 verbatim instead of quoting it; malformed syntax throws. */
  raw?: boolean;
}

/** Split a snippet into plain and matched runs. Unpaired delimiters are dropped. */
export function splitSnippet(snippet: string): Array<{ text: string; match: boolean }> {
  const runs: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  while (index < snippet.length) {
    const open = snippet.indexOf(MATCH_OPEN, index);
    if (open === -1) break;
    const close = snippet.indexOf(MATCH_CLOSE, open + 1);
    if (close === -1) break;
    if (open > index) runs.push({ text: snippet.slice(index, open), match: false });
    if (close > open + 1) runs.push({ text: snippet.slice(open + 1, close), match: true });
    index = close + 1;
  }
  const tail = snippet.slice(index);
  if (tail.length > 0) runs.push({ text: stripDelimiters(tail), match: false });
  return runs;
}

export function stripDelimiters(text: string): string {
  return text.replaceAll(MATCH_OPEN, "").replaceAll(MATCH_CLOSE, "");
}
