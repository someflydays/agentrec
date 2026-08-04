import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { FORK_TOKEN_HEADER } from "@agentrec/core";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

let token: string | undefined;

/**
 * One token per process, handed to the SPA by /api/capabilities and by the
 * served index.html. It is no secret from the user, only from other origins:
 * nothing else on the machine can read a same-origin response of this server.
 */
export function processToken(): string {
  token ??= randomBytes(32).toString("hex");
  return token;
}

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

function isOwnOrigin(origin: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const declared = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return declared === port;
}

/**
 * Listening on loopback keeps the store off the network but not away from the
 * browser: any page the user has open can send requests to 127.0.0.1, and a
 * name that resolves there (DNS rebinding) arrives here carrying the attacker's
 * own Host. So a request is refused unless the origin it declares is this exact
 * server — a same-origin GET normally sends no Origin at all, a cross-origin
 * one always does — and unless its Host names loopback. Returns the refusal
 * reason, or null when the request may proceed.
 */
export function crossOriginRefusal(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin !== undefined && !isOwnOrigin(origin, req.socket.localPort ?? -1)) {
    return `requests from origin ${origin} are not allowed`;
  }
  const host = req.headers.host;
  if (host !== undefined && !LOOPBACK_HOSTS.has(hostnameOf(host) ?? "")) {
    return `requests for host ${host} are not allowed`;
  }
  return null;
}

/**
 * Lengths are compared first: timingSafeEqual throws on a mismatch, and the
 * length of a hex token is not the part worth hiding.
 */
export function hasForkToken(req: IncomingMessage): boolean {
  const header = req.headers[FORK_TOKEN_HEADER];
  const provided = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(processToken());
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}
