import type { ReactElement } from "react";

const MAX_LINES = 600;

type LineKind = "add" | "del" | "hunk" | "meta" | "context";

/** Unified-diff text with +/− colouring; no parsing beyond the line prefix. */
export function Diff(props: { text: string }): ReactElement {
  const lines = props.text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className="diff">
      {shown.map((line, index) => (
        // Diff lines repeat, so the index is the only stable identity here.
        <div key={`${String(index)}:${line}`} className={`diff-line diff-line--${classify(line)}`}>
          {line.length > 0 ? line : " "}
        </div>
      ))}
      {lines.length > shown.length ? (
        <div className="diff-line diff-line--meta">
          … {String(lines.length - shown.length)} more lines
        </div>
      ) : null}
    </div>
  );
}

function classify(line: string): LineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}
