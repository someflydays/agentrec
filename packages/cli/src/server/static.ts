import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { sendBuffer, sendError } from "./http.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
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

  const indexPath = join(distDir, "index.html");
  if (relative.length === 0) {
    sendFile(indexPath, res, NO_STORE);
    return;
  }

  const target = resolve(distDir, relative);
  if (target !== distDir && !target.startsWith(`${distDir}${sep}`)) {
    sendError(res, 403, "path outside the dashboard bundle");
    return;
  }

  if (isFile(target)) {
    // Vite emits content-hashed asset filenames; only index.html must stay fresh.
    sendFile(target, res, relative.startsWith("assets/") ? IMMUTABLE : NO_STORE);
    return;
  }

  // SPA fallback: hash routing means every unknown path is the app shell.
  sendFile(indexPath, res, NO_STORE);
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
