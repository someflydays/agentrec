import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSearch } from "../api";
import { errorText } from "../lib/errors";
import { groupBySession, type SearchGroup, type SearchResult } from "../lib/search";

/** Long enough to skip most intermediate keystrokes, short enough to feel live. */
const DEBOUNCE_MS = 180;
const LIMIT = 40;

export type SearchStatus = "idle" | "loading" | "ready";

export interface SearchState {
  query: string;
  setQuery: (query: string) => void;
  groups: SearchGroup[];
  hits: SearchResult[];
  status: SearchStatus;
  error: string | null;
  dismissError: () => void;
}

export function useSearch(): SearchState {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef("");

  useEffect(() => {
    const trimmed = query.trim();
    latest.current = trimmed;
    if (trimmed.length === 0) {
      setResults([]);
      setStatus("idle");
      setError(null);
      return;
    }

    setStatus("loading");
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchSearch(trimmed, LIMIT, controller.signal);
          // The response echoes its query, which is what makes a late one droppable.
          if (response.query.trim() !== latest.current) return;
          setResults(response.results);
          setError(null);
          setStatus("ready");
        } catch (cause) {
          if (controller.signal.aborted) return;
          setResults([]);
          setError(errorText(cause));
          setStatus("ready");
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const groups = useMemo(() => groupBySession(results), [results]);
  const hits = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return { query, setQuery, groups, hits, status, error, dismissError };
}
