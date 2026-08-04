import type { ServerResponse } from "node:http";
import {
  type CapabilitiesResponse,
  type DiffResponse,
  diffSessions,
  type SearchOptions,
  type SearchResponse,
  type SessionDetailResponse,
  type SessionEventsResponse,
  type SessionEventType,
  type SessionListResponse,
  type SessionStore,
  search,
  summarizeSession,
  syncIndex,
} from "@agentrec/core";
import { sendError, sendJson, sendText } from "./http.js";
import { processToken } from "./security.js";

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
    sessions: store.list().map((meta) => summarizeSession(meta, store.readEvents(meta.id))),
  };
  sendJson(res, 200, body);
}

export function handleSessionDetail(store: SessionStore, id: string, res: ServerResponse): void {
  const meta = store.readMeta(id);
  const body: SessionDetailResponse = {
    meta,
    summary: summarizeSession(meta, store.readEvents(id)),
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
