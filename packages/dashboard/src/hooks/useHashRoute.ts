import { useCallback, useEffect, useState } from "react";

const PREFIX = "#/session/";

export interface HashRoute {
  sessionId: string | null;
  select: (id: string) => void;
}

/** Hash routing keeps the static server free of route-specific handling. */
export function useHashRoute(): HashRoute {
  const [sessionId, setSessionId] = useState<string | null>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => {
      setSessionId(parseHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const select = useCallback((id: string) => {
    window.location.hash = `${PREFIX}${id}`;
  }, []);

  return { sessionId, select };
}

function parseHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const id = hash.slice(PREFIX.length).split("/")[0] ?? "";
  return id.length > 0 ? decodeURIComponent(id) : null;
}
