import type { ServerResponse } from "node:http";
import {
  type SessionDetailResponse,
  type SessionEventsResponse,
  type SessionListResponse,
  type SessionStore,
  summarizeSession,
} from "@agent-blackbox/core";
import { sendError, sendJson, sendText } from "./http.js";

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
