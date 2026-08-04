import type { ReactElement } from "react";
import { splitSnippet } from "../lib/search";

/** Renders an FTS5 snippet, marking the runs the index flagged as matches. */
export function Snippet(props: { text: string }): ReactElement {
  const runs = splitSnippet(props.text);
  return (
    <>
      {runs.map((run, index) =>
        run.match ? (
          // Runs repeat within a snippet, so position is the only stable identity.
          <mark key={`${String(index)}:${run.text}`} className="hit-match">
            {run.text}
          </mark>
        ) : (
          <span key={`${String(index)}:${run.text}`}>{run.text}</span>
        ),
      )}
    </>
  );
}
