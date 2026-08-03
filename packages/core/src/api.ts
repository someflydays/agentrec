import type { SessionSummary } from "./summary.js";
import type { SessionEvent, SessionMeta } from "./types.js";

/**
 * Contract between the local dashboard server (`agentrec ui`) and the
 * dashboard SPA. All routes are same-origin, JSON unless noted.
 */
export const API_ROUTES = {
  /** GET → SessionListResponse */
  sessions: "/api/sessions",
  /** GET → SessionDetailResponse */
  session: (id: string) => `/api/sessions/${id}`,
  /** GET → SessionEventsResponse */
  events: (id: string) => `/api/sessions/${id}/events`,
  /** GET → text/plain, raw asciinema v2 cast (404 when absent) */
  cast: (id: string) => `/api/sessions/${id}/cast`,
  /** GET → text/event-stream of StreamMessage for live sessions */
  stream: (id: string) => `/api/sessions/${id}/stream`,
} as const;

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  meta: SessionMeta;
  summary: SessionSummary;
  /** True when the session has no endedAt yet (recording in progress). */
  live: boolean;
}

export interface SessionEventsResponse {
  events: SessionEvent[];
}

/**
 * SSE payloads for live follow. Each SSE `data:` line carries one JSON-encoded
 * StreamMessage; the `event:` field mirrors `kind`.
 */
export type StreamMessage =
  | { kind: "event"; event: SessionEvent }
  | { kind: "cast"; line: string }
  | { kind: "end"; exitCode: number | null };
