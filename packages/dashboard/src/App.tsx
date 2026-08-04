import type { SessionSummary } from "@agentrec/core/browser";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { fetchSessions } from "./api";
import { DiffView } from "./components/DiffView";
import { SearchPalette } from "./components/SearchPalette";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { useCapabilities } from "./hooks/useCapabilities";
import { useHashRoute } from "./hooks/useHashRoute";
import { errorText } from "./lib/errors";
import { isTypingTarget, overlayIsOpen } from "./lib/keyboard";

/** Cheap enough locally, and keeps live sessions and relative times honest. */
const LIST_POLL_MS = 10_000;

export function App(): ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const { route, nonce, openSession, openDiff } = useHashRoute();
  const capabilities = useCapabilities();

  const refresh = useCallback(async () => {
    try {
      const response = await fetchSessions();
      setSessions(response.sessions);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, LIST_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (route.kind !== "none") return;
    const newest = sessions?.[0];
    if (newest !== undefined) openSession(newest.id);
  }, [route.kind, sessions, openSession]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => (open ? false : !overlayIsOpen()));
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (overlayIsOpen() || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        error={error}
        selectedId={route.kind === "session" ? route.id : null}
        onSelect={openSession}
        onSearch={() => {
          setSearchOpen(true);
        }}
      />
      <main className="main">
        {route.kind === "session" ? (
          <SessionView
            key={route.id}
            id={route.id}
            sessions={sessions ?? []}
            focusSeq={route.seq}
            focusNonce={nonce}
            capabilities={capabilities}
            onSessionChanged={() => {
              void refresh();
            }}
            onOpenSession={openSession}
            onOpenDiff={openDiff}
          />
        ) : route.kind === "diff" ? (
          <DiffView
            key={`${route.a}:${route.b}`}
            a={route.a}
            b={route.b}
            onOpenSession={openSession}
            onSwap={() => {
              openDiff(route.b, route.a);
            }}
          />
        ) : (
          <Welcome loading={sessions === null} error={error} />
        )}
      </main>
      {searchOpen ? (
        <SearchPalette
          onClose={() => {
            setSearchOpen(false);
          }}
          onOpenResult={(result) => {
            setSearchOpen(false);
            openSession(result.sessionId, result.seq);
          }}
        />
      ) : null}
    </div>
  );
}

function Welcome(props: { loading: boolean; error: string | null }): ReactElement {
  if (props.error !== null) {
    return (
      <div className="empty">
        <h2 className="empty-title">Cannot reach the recorder</h2>
        <p className="empty-text">{props.error}</p>
      </div>
    );
  }
  if (props.loading) {
    return <p className="pane-placeholder">Loading sessions…</p>;
  }
  return (
    <div className="empty">
      <span className="empty-mark" />
      <h2 className="empty-title">Nothing recorded yet</h2>
      <p className="empty-text">
        Start a session through the recorder and every prompt, tool call, file change and terminal
        frame lands here.
      </p>
      <code className="command">agentrec claude</code>
    </div>
  );
}
