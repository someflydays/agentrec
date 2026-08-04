import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { type SearchState, useSearch } from "../hooks/useSearch";
import { formatOffset, formatRelativeTime, shortId } from "../lib/format";
import type { SearchResult } from "../lib/search";
import { Modal } from "./Modal";
import { Snippet } from "./Snippet";

interface SearchPaletteProps {
  onClose: () => void;
  onOpenResult: (result: SearchResult) => void;
}

export function SearchPalette(props: SearchPaletteProps): ReactElement {
  const search = useSearch();
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { hits } = search;
  // Results shrink between keystrokes, so the stored index is clamped on read.
  const activeIndex = hits.length === 0 ? 0 : Math.min(active, hits.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-hit="${String(activeIndex)}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const open = (result: SearchResult): void => {
    props.onOpenResult(result);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + delta + hits.length) % hits.length);
      return;
    }
    if (event.key !== "Enter") return;
    const hit = hits[activeIndex];
    if (hit !== undefined) {
      event.preventDefault();
      open(hit);
    }
  };

  return (
    <Modal title="Search" variant="palette" onClose={props.onClose}>
      <div className="palette-query">
        <span className="palette-sigil">/</span>
        <input
          ref={inputRef}
          className="palette-input"
          type="search"
          value={search.query}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search prompts, replies, tool calls and file paths"
          aria-label="Search recorded sessions"
          onChange={(event) => {
            search.setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="palette-status">{statusLabel(search)}</span>
      </div>

      {search.error !== null ? (
        <p className="inline-error">
          <span>{search.error}</span>
          <button type="button" className="inline-error-close" onClick={search.dismissError}>
            dismiss
          </button>
        </p>
      ) : null}

      <div className="palette-results" ref={listRef}>
        {search.query.trim().length === 0 ? (
          <p className="pane-placeholder">
            Type to search every recorded prompt, reply, tool call and file path.
          </p>
        ) : search.status === "loading" && hits.length === 0 ? (
          <p className="pane-placeholder">Searching…</p>
        ) : hits.length === 0 && search.error === null ? (
          <p className="pane-placeholder">No matches.</p>
        ) : (
          <ul className="hit-groups">
            {search.groups.map((group) => (
              <li key={group.id} className="hit-group">
                <p className="hit-group-head">
                  <span className="hit-group-title">{group.title ?? "untitled session"}</span>
                  <span className="hit-group-id">{shortId(group.id)}</span>
                  <span className="hit-group-age">{formatRelativeTime(group.startedAt)}</span>
                </p>
                <ul className="hits">
                  {group.hits.map((hit) => {
                    const index = hits.indexOf(hit);
                    return (
                      <li
                        key={`${hit.sessionId}:${String(hit.seq)}`}
                        data-hit={String(index)}
                        className={`hit${index === activeIndex ? " hit--active" : ""}`}
                      >
                        <button
                          type="button"
                          className="hit-hit"
                          onClick={() => {
                            open(hit);
                          }}
                          onMouseEnter={() => {
                            setActive(index);
                          }}
                        >
                          <span className="hit-offset">{formatOffset(hit.t)}</span>
                          <span className="hit-type">{hit.type}</span>
                          <span className="hit-snippet">
                            <Snippet text={hit.snippet} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="palette-foot">
        <span>
          <kbd className="key">↑</kbd>
          <kbd className="key">↓</kbd> move
        </span>
        <span>
          <kbd className="key">↵</kbd> open and seek
        </span>
        <span>
          <kbd className="key">esc</kbd> close
        </span>
      </footer>
    </Modal>
  );
}

function statusLabel(search: SearchState): string {
  if (search.query.trim().length === 0 || search.error !== null) return "";
  if (search.status === "loading") return "…";
  if (search.hits.length === 0) return "0 matches";
  return `${String(search.hits.length)} in ${String(search.groups.length)}`;
}
