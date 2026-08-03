import type { SessionSummary } from "@agentrec/core/browser";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { fetchSessions } from "./api";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { useHashRoute } from "./hooks/useHashRoute";
import { errorText } from "./lib/errors";

/** Cheap enough locally, and keeps live sessions and relative times honest. */
const LIST_POLL_MS = 10_000;

export function App(): ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { sessionId, select } = useHashRoute();

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
    if (sessionId !== null) return;
    const newest = sessions?.[0];
    if (newest !== undefined) select(newest.id);
  }, [sessionId, sessions, select]);

  return (
    <div className="app">
      <Sidebar sessions={sessions} error={error} selectedId={sessionId} onSelect={select} />
      <main className="main">
        {sessionId !== null ? (
          <SessionView
            key={sessionId}
            id={sessionId}
            onSessionChanged={() => {
              void refresh();
            }}
          />
        ) : (
          <Welcome loading={sessions === null} error={error} />
        )}
      </main>
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
