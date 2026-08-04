import type { SessionDiff } from "./diff.js";
import type { SearchResult } from "./search.js";
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
  /**
   * GET ?since-seq= → text/event-stream of StreamMessage for live sessions.
   *
   * `since-seq` is the highest event seq the client already has: the server
   * replays everything past it from disk before tailing, which is how an event
   * written between the client's `events` fetch and this subscription is not
   * lost. Omit it to receive only what is appended from now on. Cast frames
   * have no seq and are always tailed from the end, replay or not.
   */
  stream: (id: string) => `/api/sessions/${id}/stream`,
  /** GET ?q= &limit= &session= &type= (repeatable) → SearchResponse */
  search: "/api/search",
  /** GET ?a= &b= → DiffResponse */
  diff: "/api/diff",
  /** GET → ForkPointsResponse; the events a session can be forked from */
  forkPoints: (id: string) => `/api/sessions/${id}/fork-points`,
  /** POST ForkRequest → ForkResponse; only mounted when the server allows forking */
  fork: (id: string) => `/api/sessions/${id}/fork`,
  /** GET → CapabilitiesResponse; what this server instance permits */
  capabilities: "/api/capabilities",
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

export interface SearchResponse {
  results: SearchResult[];
  /** Echoed back so a stale response can be discarded by the client; "" when no query was given. */
  query: string;
}

export interface DiffResponse {
  diff: SessionDiff;
}

export interface ForkPoint {
  seq: number;
  t: number;
  type: SessionEvent["type"];
  /** Short human-readable label for the event being forked from. */
  preview: string;
}

export interface ForkPointsResponse {
  points: ForkPoint[];
  /**
   * False when the session cannot be forked — most often because the agent's
   * own transcript is no longer on disk. This is a normal state for imported
   * or expired sessions, so the route still answers 200.
   */
  available: boolean;
  /** Why forking is unavailable, when it is. */
  reason?: string;
}

export interface ForkRequest {
  seq: number;
  prompt: string;
}

export interface ForkResponse {
  /** Id of the newly recorded forked session. */
  sessionId: string;
}

/**
 * Forking spawns a real agent process, so it is opt-in per server instance
 * (`agentrec ui --allow-fork`). The dashboard reads this to decide between
 * running a fork and showing the equivalent command to copy.
 */
export interface CapabilitiesResponse {
  fork: boolean;
  /**
   * Sent as the X-Agentrec-Token header on state-changing requests. A page on
   * another origin cannot read this, which is what keeps a stray browser tab
   * from driving the local server.
   */
  token: string;
}

export const FORK_TOKEN_HEADER = "x-agentrec-token";

/** Body of every non-2xx response from the dashboard server. */
export interface ApiErrorBody {
  error: string;
}

/**
 * Status codes the dashboard branches on. Anything else should be treated as
 * an unexpected failure and surfaced verbatim from `ApiErrorBody.error`.
 *
 * - 400 malformed input (missing query param, bad seq, empty prompt)
 * - 403 rejected by the origin/host guard, or a bad fork token
 * - 404 unknown session, or the fork route on a server that does not allow forking
 * - 409 a fork is already running
 * - 413 request body too large
 * - 415 wrong content-type on a POST
 */
export type ApiErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 500;

/**
 * SSE payloads for live follow. Each SSE `data:` line carries one JSON-encoded
 * StreamMessage; the `event:` field mirrors `kind`.
 */
export type StreamMessage =
  | { kind: "event"; event: SessionEvent }
  | { kind: "cast"; line: string }
  | { kind: "end"; exitCode: number | null };
