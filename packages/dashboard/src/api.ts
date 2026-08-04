import {
  API_ROUTES,
  type CapabilitiesResponse,
  type DiffResponse,
  FORK_TOKEN_HEADER,
  type ForkPointsResponse,
  type ForkRequest,
  type ForkResponse,
  type SearchResponse,
  type SessionDetailResponse,
  type SessionEventsResponse,
  type SessionListResponse,
} from "@agentrec/core/browser";

export function fetchSessions(): Promise<SessionListResponse> {
  return getJson<SessionListResponse>(API_ROUTES.sessions);
}

export function fetchSession(id: string): Promise<SessionDetailResponse> {
  return getJson<SessionDetailResponse>(API_ROUTES.session(id));
}

export function fetchEvents(id: string): Promise<SessionEventsResponse> {
  return getJson<SessionEventsResponse>(API_ROUTES.events(id));
}

/** Null when the session has no terminal recording. */
export async function fetchCast(id: string): Promise<string | null> {
  const response = await fetch(API_ROUTES.cast(id));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await errorMessage(response));
  return await response.text();
}

export function fetchSearch(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return getJson<SearchResponse>(`${API_ROUTES.search}?${params.toString()}`, { signal });
}

export function fetchDiff(a: string, b: string): Promise<DiffResponse> {
  const params = new URLSearchParams({ a, b });
  return getJson<DiffResponse>(`${API_ROUTES.diff}?${params.toString()}`);
}

/**
 * Never rejects: a server built without fork support answers 404 here, and that
 * is a reason to show, not an error to blow up the session view with.
 */
export async function fetchForkPoints(id: string): Promise<ForkPointsResponse> {
  try {
    const response = await fetch(API_ROUTES.forkPoints(id), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const reported = await errorBody(response);
      return {
        points: [],
        available: false,
        reason: reported ?? unavailableReason(response.status),
      };
    }
    return (await response.json()) as ForkPointsResponse;
  } catch (cause) {
    return { points: [], available: false, reason: messageOf(cause) };
  }
}

/** A missing or failing capabilities route means "this server allows nothing extra". */
export async function fetchCapabilities(): Promise<CapabilitiesResponse> {
  try {
    const response = await fetch(API_ROUTES.capabilities, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return DENIED;
    const body = (await response.json()) as Record<string, unknown>;
    return {
      fork: body.fork === true,
      token: typeof body.token === "string" ? body.token : "",
    };
  } catch {
    return DENIED;
  }
}

export async function runFork(
  id: string,
  request: ForkRequest,
  token: string,
): Promise<ForkResponse> {
  const response = await fetch(API_ROUTES.fork(id), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [FORK_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(forkErrorMessage(response.status, await errorBody(response)));
  }
  return (await response.json()) as ForkResponse;
}

const DENIED: CapabilitiesResponse = { fork: false, token: "" };

const FORK_ERRORS: Readonly<Record<number, string>> = {
  400: "the fork point or the new instruction was rejected",
  403: "the server rejected this dashboard's token",
  409: "a fork is already running for this server",
  500: "the server could not start the fork",
};

function forkErrorMessage(status: number, reported: string | null): string {
  const base = reported ?? FORK_ERRORS[status] ?? `request failed with status ${String(status)}`;
  // Only the page can fix a stale token, so the server cannot suggest this itself.
  return status === 403 ? `${base} — reload the dashboard to pick up a fresh token` : base;
}

function unavailableReason(status: number): string {
  return status === 404
    ? "this server does not expose fork points"
    : `fork points request failed with status ${String(status)}`;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorBody(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function errorMessage(response: Response): Promise<string> {
  return (await errorBody(response)) ?? `request failed with status ${String(response.status)}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
