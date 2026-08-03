import type { SessionSummary } from "@agent-blackbox/core/browser";
import type { ReactElement } from "react";
import { formatCost, formatDuration, formatRelativeTime, shortId } from "../lib/format";

interface SidebarProps {
  sessions: SessionSummary[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar(props: SidebarProps): ReactElement {
  const sessions = props.sessions;
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-dot" />
          agent black box
        </div>
        <p className="sidebar-count">
          {sessions === null ? "loading…" : `${String(sessions.length)} recorded`}
        </p>
      </div>
      {props.error !== null ? <p className="sidebar-error">{props.error}</p> : null}
      {sessions !== null && sessions.length === 0 ? (
        <div className="sidebar-empty">
          <p>No recordings yet. Wrap a Claude Code session:</p>
          <code className="command">agent-blackbox claude</code>
        </div>
      ) : null}
      <ul className="session-list">
        {(sessions ?? []).map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            selected={session.id === props.selectedId}
            onSelect={props.onSelect}
          />
        ))}
      </ul>
    </aside>
  );
}

function SessionItem(props: {
  session: SessionSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const { session } = props;
  const live = session.endedAt === undefined;
  const duration = live ? Date.now() - Date.parse(session.startedAt) : session.durationMs;

  return (
    <li className={`session-item${props.selected ? " session-item--selected" : ""}`}>
      <button
        type="button"
        className="session-hit"
        onClick={() => {
          props.onSelect(session.id);
        }}
      >
        <span className="session-item-top">
          <span className="session-item-title">{session.title ?? shortId(session.id)}</span>
          {live ? <span className="live-badge">live</span> : null}
        </span>
        <span className="session-item-meta">
          <span>{formatRelativeTime(session.startedAt)}</span>
          <span className="dot-sep">·</span>
          <span>{formatDuration(duration)}</span>
          <span className="dot-sep">·</span>
          <span>{formatCost(session.totalCostUsd)}</span>
        </span>
      </button>
    </li>
  );
}
