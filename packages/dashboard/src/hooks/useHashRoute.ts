import { useCallback, useEffect, useState } from "react";

const SESSION_PREFIX = "#/session/";
const DIFF_PREFIX = "#/diff/";

export type Route =
  | { kind: "session"; id: string; seq: number | null }
  | { kind: "diff"; a: string; b: string }
  | { kind: "none" };

export interface HashRoute {
  route: Route;
  /** Bumped on every navigation, so re-selecting the same target still fires. */
  nonce: number;
  openSession: (id: string, seq?: number) => void;
  openDiff: (a: string, b: string) => void;
}

/** Hash routing keeps the static server free of route-specific handling. */
export function useHashRoute(): HashRoute {
  const [state, setState] = useState(() => ({ route: parseHash(window.location.hash), nonce: 0 }));

  useEffect(() => {
    const onHashChange = (): void => {
      setState((current) => ({ route: parseHash(window.location.hash), nonce: current.nonce + 1 }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const navigate = useCallback((hash: string) => {
    if (window.location.hash === hash) {
      // No hashchange fires, but the caller still asked to go there.
      setState((current) => ({ ...current, nonce: current.nonce + 1 }));
      return;
    }
    window.location.hash = hash;
  }, []);

  const openSession = useCallback(
    (id: string, seq?: number) => {
      const tail = seq === undefined ? "" : `/${String(seq)}`;
      navigate(`${SESSION_PREFIX}${encodeURIComponent(id)}${tail}`);
    },
    [navigate],
  );

  const openDiff = useCallback(
    (a: string, b: string) => {
      navigate(`${DIFF_PREFIX}${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    },
    [navigate],
  );

  return { route: state.route, nonce: state.nonce, openSession, openDiff };
}

function parseHash(hash: string): Route {
  if (hash.startsWith(SESSION_PREFIX)) {
    const parts = hash.slice(SESSION_PREFIX.length).split("/");
    const id = decodeSegment(parts[0]);
    if (id === null) return { kind: "none" };
    const seq = Number.parseInt(parts[1] ?? "", 10);
    return { kind: "session", id, seq: Number.isInteger(seq) && seq >= 0 ? seq : null };
  }
  if (hash.startsWith(DIFF_PREFIX)) {
    const parts = hash.slice(DIFF_PREFIX.length).split("/");
    const a = decodeSegment(parts[0]);
    const b = decodeSegment(parts[1]);
    if (a === null || b === null) return { kind: "none" };
    return { kind: "diff", a, b };
  }
  return { kind: "none" };
}

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment.length === 0) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
