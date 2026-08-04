import {
  type ReactElement,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { firstLine, formatDuration, formatOffset, summarizeToolInput } from "../lib/format";
import {
  FILTER_KINDS,
  FILTER_LABELS,
  type FilterKind,
  RowPositions,
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
  /** Row keys the session can be forked from; empty while fork points load. */
  forkable: ReadonlySet<string>;
  /** Set when forking is off for this session; shown instead of being hidden. */
  forkReason: string | null;
  onFork: (key: string) => void;
}

interface Viewport {
  top: number;
  height: number;
}

export function Timeline(props: TimelineProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLOListElement>(null);
  const positionsRef = useRef<RowPositions | null>(null);
  positionsRef.current ??= new RowPositions();
  const positions = positionsRef.current;
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 0 });
  const [, remeasured] = useReducer((tick: number) => tick + 1, 0);
  /** Row that still owes an exact scroll once it mounts. */
  const revealRef = useRef<string | null>(null);
  /** Content height at the last tail pin; -1 while not tailing. */
  const pinnedRef = useRef(-1);
  const rowCount = props.rows.length;
  const hasRows = rowCount > 0;
  const selectedKey = props.selectedKey;
  const forkSelected = selectedKey !== null && props.forkable.has(selectedKey);

  // Purely derived from the rows about to be rendered, so it belongs with them
  // rather than in an effect that would run a frame too late.
  positions.sync(props.rows);
  const mounted = positions.windowFor(viewport.top, viewport.height);

  const syncViewport = useCallback((list: HTMLOListElement) => {
    const top = list.scrollTop;
    const height = list.clientHeight;
    setViewport((current) =>
      current.top === top && current.height === height ? current : { top, height },
    );
  }, []);

  // Heights are only knowable once a row is on screen, so every commit measures
  // what is mounted and hands the cache back its real numbers.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    let moved = false;
    for (const node of list.querySelectorAll<HTMLElement>("[data-row]")) {
      const key = node.dataset.row;
      if (key === undefined) continue;
      if (positions.measure(key, node.getBoundingClientRect().height, expanded.has(key))) {
        moved = true;
      }
    }

    if (props.tailing) {
      // Rows below the fold are estimates until they mount, so the content keeps
      // growing under the tail; re-pin whenever it does, and otherwise leave a
      // deliberate scroll where the reader put it.
      if (list.scrollHeight !== pinnedRef.current) {
        pinnedRef.current = list.scrollHeight;
        const bottom = Math.max(0, list.scrollHeight - list.clientHeight);
        if (Math.abs(list.scrollTop - bottom) > 0.5) list.scrollTop = bottom;
      }
    } else {
      pinnedRef.current = -1;
      const reveal = revealRef.current;
      if (reveal !== null) {
        const node = list.querySelector<HTMLElement>(`[data-row="${reveal}"]`);
        if (node !== null) {
          revealRef.current = null;
          node.scrollIntoView({ block: "nearest" });
        }
      }
    }

    syncViewport(list);
    if (moved) remeasured();
  });

  useLayoutEffect(() => {
    if (selectedKey === null) return;
    const list = listRef.current;
    if (list === null) return;
    const index = positions.indexOf(selectedKey);
    if (index < 0) return;
    const node = list.querySelector<HTMLElement>(`[data-row="${selectedKey}"]`);
    if (node !== null) {
      node.scrollIntoView({ block: "nearest" });
      syncViewport(list);
      return;
    }
    // j/k can land on a row that was never rendered: aim with the cache, then
    // let the pass after it mounts correct for the estimate.
    const top = positions.offsetOf(index);
    const bottom = top + positions.heightOf(index);
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
    revealRef.current = selectedKey;
    syncViewport(list);
  }, [selectedKey, positions, syncViewport]);

  useEffect(() => {
    const list = listRef.current;
    if (!hasRows || list === null) return;
    let width = list.clientWidth;
    const observer = new ResizeObserver(() => {
      // Every measured height was taken at the old width.
      if (list.clientWidth !== width) {
        width = list.clientWidth;
        positions.forget();
      }
      syncViewport(list);
      remeasured();
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
    };
  }, [hasRows, positions, syncViewport]);

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
        <button
          type="button"
          className="chip"
          disabled={!forkSelected}
          title={forkTitle(props.forkReason, forkSelected)}
          onClick={() => {
            if (selectedKey !== null) props.onFork(selectedKey);
          }}
        >
          Fork ƒ
        </button>
        <span className="pane-meta">
          {rowCount === props.totalRows
            ? `${String(rowCount)} events`
            : `${String(rowCount)} of ${String(props.totalRows)}`}
        </span>
      </header>
      {props.forkReason !== null ? (
        <p className="fork-strip">
          <span className="fork-strip-label">fork unavailable</span>
          {props.forkReason}
        </p>
      ) : null}
      {rowCount === 0 ? (
        <p className="pane-placeholder">No events match the current filters.</p>
      ) : (
        <ol
          className="timeline"
          ref={listRef}
          onScroll={(event: UIEvent<HTMLOListElement>) => {
            syncViewport(event.currentTarget);
          }}
        >
          {mounted.padTop > 0 ? (
            <li className="timeline-pad" style={{ height: mounted.padTop }} aria-hidden="true" />
          ) : null}
          {props.rows.slice(mounted.start, mounted.end).map((row) =>
            row.kind === "turn" ? (
              <li key={row.key} className="turn-break" data-row={row.key}>
                <span>turn complete</span>
              </li>
            ) : (
              <RowView
                key={row.key}
                row={row}
                selected={row.key === props.selectedKey}
                expanded={expanded.has(row.key)}
                forkable={props.forkable.has(row.key)}
                onFork={props.onFork}
                onActivate={() => {
                  props.onSelect(row);
                  if (row.kind === "file") props.onOpenChange(row);
                  else toggleExpanded(row.key);
                }}
              />
            ),
          )}
          {mounted.padBottom > 0 ? (
            <li className="timeline-pad" style={{ height: mounted.padBottom }} aria-hidden="true" />
          ) : null}
        </ol>
      )}
    </section>
  );
}

interface RowViewProps {
  row: Exclude<TimelineRow, { kind: "turn" }>;
  selected: boolean;
  expanded: boolean;
  forkable: boolean;
  onFork: (key: string) => void;
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
      <div className="row-line">
        <button type="button" className="row-hit" onClick={props.onActivate}>
          <span className="row-offset">{formatOffset(row.t)}</span>
          <span className="row-body">{renderHead(row, props.expanded)}</span>
        </button>
        {props.forkable ? (
          <button
            type="button"
            className="row-fork"
            title="Fork from here"
            onClick={() => {
              props.onFork(row.key);
            }}
          >
            fork
          </button>
        ) : null}
      </div>
      {props.expanded ? renderDetail(row) : null}
    </li>
  );
}

function forkTitle(reason: string | null, selected: boolean): string {
  if (reason !== null) return reason;
  if (selected) return "Fork from the selected event (f)";
  return "Select a prompt or an assistant reply to fork from";
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
