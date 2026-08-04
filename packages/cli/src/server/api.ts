import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import {
  type CapabilitiesResponse,
  type DiffResponse,
  diffSessions,
  EVENTS_FILE,
  META_FILE,
  type SearchOptions,
  type SearchResponse,
  type SessionDetailResponse,
  type SessionEventsResponse,
  type SessionEventType,
  type SessionListResponse,
  type SessionMeta,
  type SessionStore,
  type SessionSummary,
  search,
  summarizeSession,
  syncIndex,
} from "@agentrec/core";
import { sendError, sendJson, sendText } from "./http.js";
import { processToken } from "./security.js";

interface CachedSummary {
  eventsMtimeMs: number;
  eventsSize: number;
  metaMtimeMs: number;
  metaSize: number;
  summary: SessionSummary;
}

/**
 * The dashboard polls the session list every few seconds, and summarizing means
 * reading and parsing every event of every session — so the answer is memoized
 * against the files it was derived from.
 *
 * Keyed by the session directory rather than the bare id: one process can serve
 * more than one store (tests do), and two stores can hold the same id.
 *
 * No TTL and no eviction. An entry is a few hundred bytes, one per session ever
 * asked for, and the process is a local dashboard someone runs for an afternoon;
 * a store with a very large number of sessions would hold them all until exit.
 */
const summaryCache = new Map<string, CachedSummary>();

/**
 * Stats are the invalidation key, so a live session (whose events.jsonl grows on
 * every append) re-summarizes on the next poll while an ended one keeps hitting
 * the cache. meta.json is stated too: a title or endedAt landing late rewrites
 * it, and although events.jsonl grows in the same breath today, that coupling is
 * the recorder's business, not something this cache should depend on.
 */
function cachedSummary(store: SessionStore, meta: SessionMeta): SessionSummary {
  const dir = store.sessionDir(meta.id);
  const events = fileStamp(join(dir, EVENTS_FILE));
  const metaStamp = fileStamp(join(dir, META_FILE));
  const hit = summaryCache.get(dir);
  if (
    hit !== undefined &&
    hit.eventsMtimeMs === events.mtimeMs &&
    hit.eventsSize === events.size &&
    hit.metaMtimeMs === metaStamp.mtimeMs &&
    hit.metaSize === metaStamp.size
  ) {
    return hit.summary;
  }

  const summary = summarizeSession(meta, store.readEvents(meta.id));
  summaryCache.set(dir, {
    eventsMtimeMs: events.mtimeMs,
    eventsSize: events.size,
    metaMtimeMs: metaStamp.mtimeMs,
    metaSize: metaStamp.size,
    summary,
  });
  return summary;
}

/** A missing file gets an impossible stamp, so it never matches a real one. */
function fileStamp(path: string): { mtimeMs: number; size: number } {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats === undefined ? { mtimeMs: -1, size: -1 } : stats;
}

/** Resolves an id or unambiguous prefix, answering 404 itself when it cannot. */
export function resolveSessionId(
  store: SessionStore,
  idOrPrefix: string,
  res: ServerResponse,
): string | null {
  try {
    return store.resolveId(idOrPrefix);
  } catch (error) {
    sendError(res, 404, error instanceof Error ? error.message : "session not found");
    return null;
  }
}

export function handleSessionList(store: SessionStore, res: ServerResponse): void {
  // store.list() is already sorted newest-first.
  const body: SessionListResponse = {
    sessions: store.list().map((meta) => cachedSummary(store, meta)),
  };
  sendJson(res, 200, body);
}

export function handleSessionDetail(store: SessionStore, id: string, res: ServerResponse): void {
  const meta = store.readMeta(id);
  const body: SessionDetailResponse = {
    meta,
    summary: cachedSummary(store, meta),
    live: meta.endedAt === undefined,
  };
  sendJson(res, 200, body);
}

export function handleSessionEvents(store: SessionStore, id: string, res: ServerResponse): void {
  const body: SessionEventsResponse = { events: store.readEvents(id) };
  sendJson(res, 200, body);
}

export function handleSessionCast(store: SessionStore, id: string, res: ServerResponse): void {
  const cast = store.readCast(id);
  if (cast === null) {
    sendError(res, 404, `session ${id} has no terminal recording`);
    return;
  }
  sendText(res, 200, "text/plain; charset=utf-8", cast);
}

export function handleCapabilities(allowFork: boolean, res: ServerResponse): void {
  const body: CapabilitiesResponse = { fork: allowFork, token: processToken() };
  sendJson(res, 200, body);
}

export function handleSearch(
  store: SessionStore,
  params: URLSearchParams,
  res: ServerResponse,
): void {
  const query = params.get("q") ?? "";
  // The dashboard searches on every keystroke, so an empty box is an empty
  // result set rather than a client error.
  if (query.length === 0) {
    const body: SearchResponse = { results: [], query: "" };
    sendJson(res, 200, body);
    return;
  }

  const options: SearchOptions = {};
  const limit = params.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      sendError(res, 400, `invalid limit "${limit}" — expected a positive integer`);
      return;
    }
    options.limit = parsed;
  }

  const session = params.get("session");
  if (session !== null && session.length > 0) {
    const id = resolveSessionId(store, session, res);
    if (id === null) return;
    options.sessionId = id;
  }

  // An event type the recorder never writes simply matches nothing, so the
  // filter is passed through without a table of valid names to drift from.
  const types = params.getAll("type").filter((type) => type.length > 0);
  if (types.length > 0) options.types = types as SessionEventType[];

  syncIndex(store);
  const body: SearchResponse = { results: search(store, query, options), query };
  sendJson(res, 200, body);
}

export function handleDiff(
  store: SessionStore,
  params: URLSearchParams,
  res: ServerResponse,
): void {
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  if (a.length === 0 || b.length === 0) {
    sendError(res, 400, "diff needs both `a` and `b` session ids");
    return;
  }

  const idA = resolveSessionId(store, a, res);
  if (idA === null) return;
  const idB = resolveSessionId(store, b, res);
  if (idB === null) return;

  const body: DiffResponse = {
    diff: diffSessions(
      { meta: store.readMeta(idA), events: store.readEvents(idA) },
      { meta: store.readMeta(idB), events: store.readEvents(idB) },
    ),
  };
  sendJson(res, 200, body);
}
