import type { IncomingMessage, ServerResponse } from "node:http";
import { API_ROUTES, type SessionStore } from "@agentrec/core";
import {
  handleCapabilities,
  handleDiff,
  handleSearch,
  handleSessionCast,
  handleSessionDetail,
  handleSessionEvents,
  handleSessionList,
  resolveSessionId,
} from "./api.js";
import { createForkHandler, type ForkHandler, handleForkPoints } from "./fork.js";
import type { ForkLauncher } from "./fork-runner.js";
import { sendError } from "./http.js";
import { crossOriginRefusal } from "./security.js";
import { serveStatic } from "./static.js";
import { handleSessionStream } from "./stream.js";

const SESSION_PREFIX = `${API_ROUTES.sessions}/`;
const API_PREFIX = "/api/";

export interface RouterOptions {
  store: SessionStore;
  distDir: string;
  /** Mounts the fork route at all; without it that surface does not exist. */
  allowFork?: boolean;
  /** Overridable so the fork route can be driven without spawning an agent. */
  launchFork?: ForkLauncher;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createRequestListener(options: RouterOptions): RequestListener {
  const fork = options.allowFork === true ? createForkHandler(options.launchFork) : null;

  return (req, res) => {
    const refusal = crossOriginRefusal(req);
    if (refusal !== null) {
      sendError(res, 403, refusal);
      return;
    }
    const url = parseUrl(req.url);
    if (url === null) {
      sendError(res, 400, "malformed request URL");
      return;
    }
    try {
      dispatch(options, fork, url, req, res);
    } catch (error) {
      // Without this a throwing handler becomes an uncaught exception, which
      // takes the whole dashboard down over one bad session directory.
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, error instanceof Error ? error.message : String(error));
    }
  };
}

function dispatch(
  options: RouterOptions,
  fork: ForkHandler | null,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const pathname = url.pathname;
  if (pathname === API_ROUTES.capabilities) {
    if (requireGet(req, res)) handleCapabilities(fork !== null, res);
    return;
  }
  if (pathname === API_ROUTES.search) {
    if (requireGet(req, res)) handleSearch(options.store, url.searchParams, res);
    return;
  }
  if (pathname === API_ROUTES.diff) {
    if (requireGet(req, res)) handleDiff(options.store, url.searchParams, res);
    return;
  }
  if (pathname === API_ROUTES.sessions) {
    if (requireGet(req, res)) handleSessionList(options.store, res);
    return;
  }
  if (pathname.startsWith(SESSION_PREFIX)) {
    handleSessionRoute(options.store, fork, pathname.slice(SESSION_PREFIX.length), req, res);
    return;
  }
  if (pathname.startsWith(API_PREFIX)) {
    sendError(res, 404, `unknown API route ${pathname}`);
    return;
  }
  if (requireGet(req, res)) serveStatic(options.distDir, pathname, res);
}

function handleSessionRoute(
  store: SessionStore,
  fork: ForkHandler | null,
  rest: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const rawId = segments[0];
  if (rawId === undefined || segments.length > 2) {
    sendError(res, 404, `unknown API route ${API_ROUTES.sessions}/${rest}`);
    return;
  }

  const sub = segments[1];
  if (sub === "fork") {
    if (fork === null) {
      sendError(res, 404, `unknown API route ${API_ROUTES.fork(rawId)}`);
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, `method ${req.method ?? "unknown"} is not allowed`);
      return;
    }
  } else if (!requireGet(req, res)) {
    return;
  }

  const id = resolveSessionId(store, decodeURIComponent(rawId), res);
  if (id === null) return;

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
    case "fork-points":
      handleForkPoints(store, id, res);
      return;
    case "fork":
      fork?.(store, id, req, res);
      return;
    default:
      sendError(res, 404, `unknown API route ${API_ROUTES.session(id)}/${sub}`);
  }
}

function requireGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET") return true;
  sendError(res, 405, `method ${req.method ?? "unknown"} is not allowed`);
  return false;
}

function parseUrl(url: string | undefined): URL | null {
  try {
    return new URL(url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}
