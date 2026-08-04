import type { SessionSummary } from "@agentrec/core/browser";
import type { ReactElement } from "react";
import { formatCost, formatDuration, formatRelativeTime, shortId } from "../lib/format";
import { Modal } from "./Modal";

interface DiffPickerProps {
  sessions: SessionSummary[];
  currentId: string;
  onClose: () => void;
  onPick: (id: string) => void;
}

export function DiffPicker(props: DiffPickerProps): ReactElement {
  const others = props.sessions.filter((session) => session.id !== props.currentId);

  return (
    <Modal title="Compare with" onClose={props.onClose}>
      <div className="modal-body modal-body--flush">
        {others.length === 0 ? (
          <p className="pane-placeholder">
            There is no other recorded session to compare this one against.
          </p>
        ) : (
          <ul className="picker">
            {others.map((session) => (
              <li key={session.id} className="picker-item">
                <button
                  type="button"
                  className="picker-hit"
                  onClick={() => {
                    props.onPick(session.id);
                  }}
                >
                  <span className="picker-title">{session.title ?? "untitled session"}</span>
                  <span className="picker-id">{shortId(session.id)}</span>
                  <span className="picker-meta">
                    <span>{formatRelativeTime(session.startedAt)}</span>
                    <span className="dot-sep">·</span>
                    <span>{formatDuration(session.durationMs)}</span>
                    <span className="dot-sep">·</span>
                    <span>{formatCost(session.totalCostUsd)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
