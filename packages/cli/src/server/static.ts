import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { sendBuffer, sendError, sendText } from "./http.js";
import { processToken } from "./security.js";

const HTML_TYPE = "text/html; charset=utf-8";

/** Read by the SPA before its first request, so it never has to bootstrap unauthenticated. */
export const TOKEN_META_NAME = "agentrec-token";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": HTML_TYPE,
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

export function serveStatic(distDir: string, pathname: string, res: ServerResponse): void {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    sendError(res, 400, "malformed request path");
    return;
  }

  if (relative.length === 0) {
    sendIndex(distDir, res);
    return;
  }

  const target = resolve(distDir, relative);
  if (target !== distDir && !target.startsWith(`${distDir}${sep}`)) {
    sendError(res, 403, "path outside the dashboard bundle");
    return;
  }

  if (isFile(target)) {
    if (target === join(distDir, "index.html")) {
      sendIndex(distDir, res);
      return;
    }
    // Vite emits content-hashed asset filenames; only index.html must stay fresh.
    sendFile(target, res, relative.startsWith("assets/") ? IMMUTABLE : NO_STORE);
    return;
  }

  // SPA fallback: hash routing means every unknown path is the app shell.
  sendIndex(distDir, res);
}

/** Hex by construction, so it needs no escaping to sit in an attribute. */
function injectToken(html: string, token: string): string {
  const meta = `<meta name="${TOKEN_META_NAME}" content="${token}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head === null) return `${meta}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

function sendIndex(distDir: string, res: ServerResponse): void {
  let html: string;
  try {
    html = readFileSync(join(distDir, "index.html"), "utf8");
  } catch {
    sendError(res, 404, "not found");
    return;
  }
  sendText(res, 200, HTML_TYPE, injectToken(html, processToken()));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendFile(path: string, res: ServerResponse, cacheControl: string): void {
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch {
    sendError(res, 404, "not found");
    return;
  }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  sendBuffer(res, 200, contentType, body, cacheControl);
}
