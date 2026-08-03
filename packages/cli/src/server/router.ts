import type { IncomingMessage, ServerResponse } from "node:http";
import { API_ROUTES, type SessionStore } from "@agentrec/core";
import {
  handleSessionCast,
  handleSessionDetail,
  handleSessionEvents,
  handleSessionList,
  resolveSessionId,
} from "./api.js";
import { sendError } from "./http.js";
import { serveStatic } from "./static.js";
import { handleSessionStream } from "./stream.js";

const SESSION_PREFIX = `${API_ROUTES.sessions}/`;
const API_PREFIX = "/api/";

export interface RouterOptions {
  store: SessionStore;
  distDir: string;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createRequestListener(options: RouterOptions): RequestListener {
  return (req, res) => {
    const pathname = parsePathname(req.url);
    if (pathname === null) {
      sendError(res, 400, "malformed request URL");
      return;
    }
    if (req.method !== "GET") {
      sendError(res, 405, `method ${req.method ?? "unknown"} is not allowed`);
      return;
    }

    if (pathname === API_ROUTES.sessions) {
      handleSessionList(options.store, res);
      return;
    }
    if (pathname.startsWith(SESSION_PREFIX)) {
      handleSessionRoute(options.store, pathname.slice(SESSION_PREFIX.length), res);
      return;
    }
    if (pathname.startsWith(API_PREFIX)) {
      sendError(res, 404, `unknown API route ${pathname}`);
      return;
    }
    serveStatic(options.distDir, pathname, res);
  };
}

function handleSessionRoute(store: SessionStore, rest: string, res: ServerResponse): void {
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const rawId = segments[0];
  if (rawId === undefined || segments.length > 2) {
    sendError(res, 404, `unknown API route ${API_ROUTES.sessions}/${rest}`);
    return;
  }

  const id = resolveSessionId(store, decodeURIComponent(rawId), res);
  if (id === null) return;

  const sub = segments[1];
  switch (sub) {
    case undefined:
      handleSessionDetail(store, id, res);
      return;
    case "events":
      handleSessionEvents(store, id, res);
      return;
    case "cast":
      handleSessionCast(store, id, res);
      return;
    case "stream":
      handleSessionStream(store, id, res);
      return;
    default:
      sendError(res, 404, `unknown API route ${API_ROUTES.session(id)}/${sub}`);
  }
}

function parsePathname(url: string | undefined): string | null {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}
