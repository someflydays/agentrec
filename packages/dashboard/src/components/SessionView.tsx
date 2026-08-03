import {
  type Cast,
  parseCast,
  type SessionDetailResponse,
  type SessionEvent,
} from "@agentrec/core/browser";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCast, fetchEvents, fetchSession } from "../api";
import { useLiveStream } from "../hooks/useLiveStream";
import { parseCastLine } from "../lib/cast";
import { errorText } from "../lib/errors";
import {
  buildTimeline,
  FILTER_KINDS,
  type FilterKind,
  fileRows,
  isFilterKind,
  type TimelineRow,
} from "../lib/timeline";
import { ChangesTab } from "./ChangesTab";
import { SessionHeader } from "./SessionHeader";
import { type CastStatus, type PlayerHandle, TerminalPane } from "./TerminalPane";
import { Timeline } from "./Timeline";
import { UsageTab } from "./UsageTab";

type Tab = "changes" | "usage";

interface SessionViewProps {
  id: string;
  /** Lets the sidebar pick up a title or an ended session. */
  onSessionChanged: () => void;
}

export function SessionView(props: SessionViewProps): ReactElement {
  const { id } = props;
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [cast, setCast] = useState<Cast | null>(null);
  const [castStatus, setCastStatus] = useState<CastStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReadonlySet<FilterKind>>(() => new Set(FILTER_KINDS));
  const [tab, setTab] = useState<Tab>("changes");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusChange, setFocusChange] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const playerRef = useRef<PlayerHandle | null>(null);
  const live = detail?.live === true;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setEvents([]);
    setCast(null);
    setCastStatus("loading");
    setError(null);

    const load = async (): Promise<void> => {
      try {
        const [detailResponse, eventsResponse] = await Promise.all([
          fetchSession(id),
          fetchEvents(id),
        ]);
        if (cancelled) return;
        setDetail(detailResponse);
        setEvents(eventsResponse.events);
        setFollow(detailResponse.live);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
        return;
      }
      try {
        const text = await fetchCast(id);
        if (cancelled) return;
        if (text === null) {
          setCastStatus("missing");
          return;
        }
        setCast(parseCast(text));
        setCastStatus("ready");
      } catch {
        if (!cancelled) setCastStatus("error");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const refreshDetail = useCallback(() => {
    void fetchSession(id)
      .then((response) => {
        setDetail(response);
        setFollow(false);
      })
      .catch(() => {
        // the session list poll will surface a real failure
      });
  }, [id]);

  useLiveStream(id, live, {
    onEvent: (event) => {
      setEvents((current) => {
        const last = current[current.length - 1];
        if (last !== undefined && event.seq <= last.seq) return current;
        return [...current, event];
      });
    },
    onCastLine: (line) => {
      const parsed = parseCastLine(line);
      if (parsed !== null) playerRef.current?.appendLive(parsed);
    },
    onEnd: () => {
      refreshDetail();
      props.onSessionChanged();
    },
  });

  const rows = useMemo(() => buildTimeline(events), [events]);
  const visibleRows = useMemo(() => rows.filter((row) => isVisible(row, filters)), [rows, filters]);
  const changes = useMemo(() => fileRows(rows), [rows]);

  const selectRow = useCallback(
    (row: TimelineRow) => {
      setSelectedKey(row.key);
      if (follow) setFollow(false);
      playerRef.current?.seek(row.t / 1000);
    },
    [follow],
  );

  const step = useCallback(
    (delta: number) => {
      const navigable = visibleRows.filter((row) => row.kind !== "turn");
      if (navigable.length === 0) return;
      const current = navigable.findIndex((row) => row.key === selectedKey);
      const index =
        current === -1
          ? delta > 0
            ? 0
            : navigable.length - 1
          : Math.max(0, Math.min(navigable.length - 1, current + delta));
      const row = navigable[index];
      if (row !== undefined) selectRow(row);
    },
    [visibleRows, selectedKey, selectRow],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === " ") {
        // A focused button already toggles on Space via its own activation.
        if (tag === "BUTTON") return;
        event.preventDefault();
        playerRef.current?.togglePlay();
        return;
      }
      if (event.key === "j") {
        event.preventDefault();
        step(1);
        return;
      }
      if (event.key === "k") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [step]);

  if (error !== null) {
    return (
      <div className="empty">
        <h2 className="empty-title">Could not load session</h2>
        <p className="empty-text">{error}</p>
      </div>
    );
  }
  if (detail === null) {
    return <p className="pane-placeholder">Loading session…</p>;
  }

  return (
    <div className="session">
      <SessionHeader detail={detail} />
      <div className="session-body">
        <Timeline
          rows={visibleRows}
          totalRows={rows.length}
          filters={filters}
          onToggleFilter={(kind) => {
            setFilters((current) => toggle(current, kind));
          }}
          selectedKey={selectedKey}
          onSelect={selectRow}
          onOpenChange={(row) => {
            setTab("changes");
            setFocusChange(row.key);
          }}
          tailing={live && follow}
        />
        <div className="session-right">
          <TerminalPane
            cast={cast}
            status={castStatus}
            live={live}
            follow={follow}
            onFollowChange={setFollow}
            handleRef={playerRef}
          />
          <section className="pane pane--tabs">
            <header className="pane-header">
              <div className="filters">
                <button
                  type="button"
                  className={`chip${tab === "changes" ? " chip--on" : ""}`}
                  onClick={() => {
                    setTab("changes");
                  }}
                >
                  Changes {changes.length > 0 ? changes.length : ""}
                </button>
                <button
                  type="button"
                  className={`chip${tab === "usage" ? " chip--on" : ""}`}
                  onClick={() => {
                    setTab("usage");
                  }}
                >
                  Usage
                </button>
              </div>
            </header>
            <div className="tab-body">
              {tab === "changes" ? (
                <ChangesTab
                  rows={changes}
                  focusKey={focusChange}
                  onSeek={(row) => {
                    selectRow(row);
                  }}
                />
              ) : (
                <UsageTab summary={detail.summary} />
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Chips narrow the four content kinds; separators and notices ride along only
 * while nothing is being filtered, so a narrowed view stays scannable.
 */
function isVisible(row: TimelineRow, filters: ReadonlySet<FilterKind>): boolean {
  if (isFilterKind(row.kind)) return filters.has(row.kind);
  return filters.size === FILTER_KINDS.length;
}

function toggle(current: ReadonlySet<FilterKind>, kind: FilterKind): ReadonlySet<FilterKind> {
  const next = new Set(current);
  if (!next.delete(kind)) next.add(kind);
  return next;
}
