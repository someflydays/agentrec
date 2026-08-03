import type { ServerResponse } from "node:http";

/** Shape of every non-2xx JSON body the dashboard server produces. */
export interface ApiErrorBody {
  error: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(body)));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  const body: ApiErrorBody = { error: message };
  sendJson(res, status, body);
}

export function sendText(
  res: ServerResponse,
  status: number,
  contentType: string,
  text: string,
): void {
  sendBuffer(res, status, contentType, Buffer.from(text, "utf8"));
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  cacheControl = "no-store",
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": body.byteLength,
    "cache-control": cacheControl,
  });
  res.end(body);
}
