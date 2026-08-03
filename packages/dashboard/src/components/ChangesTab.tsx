import { type ReactElement, useEffect, useRef, useState } from "react";
import { formatOffset } from "../lib/format";
import type { FileRow } from "../lib/timeline";
import { Diff } from "./Diff";

interface ChangesTabProps {
  rows: FileRow[];
  focusKey: string | null;
  onSeek: (row: FileRow) => void;
}

export function ChangesTab(props: ChangesTabProps): ReactElement {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const focusKey = props.focusKey;

  useEffect(() => {
    if (focusKey === null) return;
    setOpen((current) => new Set(current).add(focusKey));
    listRef.current?.querySelector(`[data-change="${focusKey}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [focusKey]);

  if (props.rows.length === 0) {
    return <p className="pane-placeholder">No file changes were recorded in this session.</p>;
  }

  return (
    <ul className="changes" ref={listRef}>
      {props.rows.map((row) => {
        const expanded = open.has(row.key);
        return (
          <li
            key={row.key}
            data-change={row.key}
            className={`change${row.key === focusKey ? " change--focused" : ""}`}
          >
            <button
              type="button"
              className="change-hit"
              onClick={() => {
                props.onSeek(row);
                setOpen((current) => {
                  const next = new Set(current);
                  if (!next.delete(row.key)) next.add(row.key);
                  return next;
                });
              }}
            >
              <span className="change-offset">{formatOffset(row.t)}</span>
              <span className={`row-label row-label--${row.change}`}>{row.change}</span>
              <span className="change-path">{row.path}</span>
              <span className="change-caret">{expanded ? "−" : "+"}</span>
            </button>
            {expanded ? (
              row.diff !== undefined && row.diff.length > 0 ? (
                <Diff text={row.diff} />
              ) : (
                <p className="change-nodiff">No diff was captured for this change.</p>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
