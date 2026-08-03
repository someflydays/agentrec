import {
  API_ROUTES,
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // non-JSON error body
  }
  return `request failed with status ${String(response.status)}`;
}
