import { type ReactElement, useEffect, useRef, useState } from "react";
import { firstLine, formatDuration, formatOffset, summarizeToolInput } from "../lib/format";
import {
  FILTER_KINDS,
  FILTER_LABELS,
  type FilterKind,
  type TimelineRow,
  type ToolRow,
} from "../lib/timeline";

const CLAMP_LINES = 6;
const CLAMP_CHARS = 420;
const OUTPUT_LIMIT = 8000;

interface TimelineProps {
  rows: TimelineRow[];
  totalRows: number;
  filters: ReadonlySet<FilterKind>;
  onToggleFilter: (kind: FilterKind) => void;
  selectedKey: string | null;
  onSelect: (row: TimelineRow) => void;
  onOpenChange: (row: TimelineRow) => void;
  tailing: boolean;
}

export function Timeline(props: TimelineProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLOListElement>(null);
  const rowCount = props.rows.length;

  useEffect(() => {
    const list = listRef.current;
    if (!props.tailing || list === null || rowCount === 0) return;
    list.scrollTop = list.scrollHeight;
  }, [props.tailing, rowCount]);

  useEffect(() => {
    if (props.selectedKey === null) return;
    const list = listRef.current;
    const node = list?.querySelector(`[data-row="${props.selectedKey}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [props.selectedKey]);

  const toggleExpanded = (key: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  return (
    <section className="pane pane--timeline">
      <header className="pane-header">
        <h2 className="pane-title">Timeline</h2>
        <div className="filters">
          {FILTER_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip${props.filters.has(kind) ? " chip--on" : ""}`}
              onClick={() => {
                props.onToggleFilter(kind);
              }}
            >
              {FILTER_LABELS[kind]}
            </button>
          ))}
        </div>
        <span className="pane-meta">
          {rowCount === props.totalRows
            ? `${String(rowCount)} events`
            : `${String(rowCount)} of ${String(props.totalRows)}`}
        </span>
      </header>
      {rowCount === 0 ? (
        <p className="pane-placeholder">No events match the current filters.</p>
      ) : (
        <ol className="timeline" ref={listRef}>
          {props.rows.map((row) =>
            row.kind === "turn" ? (
              <li key={row.key} className="turn-break">
                <span>turn complete</span>
              </li>
            ) : (
              <RowView
                key={row.key}
                row={row}
                selected={row.key === props.selectedKey}
                expanded={expanded.has(row.key)}
                onActivate={() => {
                  props.onSelect(row);
                  if (row.kind === "file") props.onOpenChange(row);
                  else toggleExpanded(row.key);
                }}
              />
            ),
          )}
        </ol>
      )}
    </section>
  );
}

interface RowViewProps {
  row: Exclude<TimelineRow, { kind: "turn" }>;
  selected: boolean;
  expanded: boolean;
  onActivate: () => void;
}

function RowView(props: RowViewProps): ReactElement {
  const { row } = props;
  const className = [
    "row",
    `row--${row.kind}`,
    props.selected ? "row--selected" : "",
    row.kind === "tool" && row.ok === false ? "row--failed" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return (
    <li className={className} data-row={row.key}>
      <button type="button" className="row-hit" onClick={props.onActivate}>
        <span className="row-offset">{formatOffset(row.t)}</span>
        <span className="row-body">{renderHead(row, props.expanded)}</span>
      </button>
      {props.expanded ? renderDetail(row) : null}
    </li>
  );
}

function renderHead(row: RowViewProps["row"], expanded: boolean): ReactElement {
  switch (row.kind) {
    case "prompt":
      return (
        <>
          <span className="row-label">prompt</span>
          <span className={textClass(row.text, expanded)}>{row.text}</span>
        </>
      );
    case "assistant":
      return (
        <>
          <span className="row-label">
            assistant
            {row.model !== undefined ? <em className="row-model">{row.model}</em> : null}
          </span>
          <span className={textClass(row.text, expanded)}>{row.text}</span>
        </>
      );
    case "tool":
      return (
        <span className="row-tool">
          <span className="row-tool-name">{row.name}</span>
          <span className="row-tool-summary">{summarizeToolInput(row.name, row.input)}</span>
          <span className="row-tool-meta">
            {row.durationMs !== undefined ? (
              <span className="row-duration">{formatDuration(row.durationMs)}</span>
            ) : null}
            <span className={`status-dot${statusSuffix(row)}`} />
          </span>
        </span>
      );
    case "file":
      return (
        <>
          <span className={`row-label row-label--${row.change}`}>{row.change}</span>
          <span className="row-path">{row.path}</span>
        </>
      );
    case "notice":
      return (
        <>
          <span className={`row-label${row.level === "error" ? " row-label--error" : ""}`}>
            {row.label}
          </span>
          <span className="row-text">{firstLine(row.message, 240)}</span>
        </>
      );
  }
}

function renderDetail(row: RowViewProps["row"]): ReactElement | null {
  if (row.kind !== "tool") return null;
  const output = row.output;
  return (
    <div className="row-detail">
      <pre className="code-block">{formatInput(row.input)}</pre>
      {output !== undefined && output.length > 0 ? (
        <pre className="code-block code-block--output">{truncate(output)}</pre>
      ) : null}
    </div>
  );
}

function textClass(text: string, expanded: boolean): string {
  const clamped = !expanded && (text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES);
  return clamped ? "row-text row-text--clamped" : "row-text";
}

function statusSuffix(row: ToolRow): string {
  if (row.ok === undefined) return " status-dot--pending";
  return row.ok ? " status-dot--ok" : " status-dot--fail";
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return truncate(JSON.stringify(input, null, 2) ?? "");
  } catch {
    return String(input);
  }
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… truncated` : text;
}
