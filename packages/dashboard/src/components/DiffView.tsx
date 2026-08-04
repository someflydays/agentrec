import type { SessionSummary } from "@agentrec/core/browser";
import { type ReactElement, useEffect, useState } from "react";
import { fetchDiff } from "../api";
import {
  type AlignedTurn,
  deltaTone,
  formatDelta,
  oneLine,
  type SessionDiff,
  type SessionTurn,
  type SetDiff,
  type ToolAlignment,
  type ToolCall,
} from "../lib/diff";
import { errorText } from "../lib/errors";
import {
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
  shortId,
  shortModel,
} from "../lib/format";

/** Long set sections collapse: a 300-file diff should not bury the turns below it. */
const SET_PREVIEW = 8;

interface DiffViewProps {
  a: string;
  b: string;
  onOpenSession: (id: string) => void;
  onSwap: () => void;
}

export function DiffView(props: DiffViewProps): ReactElement {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { a, b } = props;

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    void fetchDiff(a, b)
      .then((response) => {
        if (!cancelled) setDiff(response.diff);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [a, b]);

  if (error !== null) {
    return (
      <div className="empty">
        <h2 className="empty-title">Could not compare these sessions</h2>
        <p className="empty-text">{error}</p>
        <button
          type="button"
          className="player-button"
          onClick={() => {
            props.onOpenSession(a);
          }}
        >
          Back to A
        </button>
      </div>
    );
  }
  if (diff === null) {
    return <p className="pane-placeholder">Comparing sessions…</p>;
  }

  return (
    <div className="session">
      <header className="session-head">
        <div className="session-head-top">
          <h1 className="session-title">Compare</h1>
          <button type="button" className="chip" onClick={props.onSwap}>
            swap A/B
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              props.onOpenSession(a);
            }}
          >
            back to A
          </button>
        </div>
        <div className="cmp-sides">
          <Side label="A" summary={diff.a} onOpen={props.onOpenSession} />
          <Side label="B" summary={diff.b} onOpen={props.onOpenSession} />
        </div>
      </header>

      <div className="cmp-body">
        <section className="usage-block">
          <h3 className="usage-title">Totals</h3>
          <Totals diff={diff} />
        </section>

        <section className="usage-block">
          <h3 className="usage-title">
            Alignment{" "}
            <span className="usage-note">
              turns pair above {diff.similarityThreshold.toFixed(2)} prompt similarity
            </span>
          </h3>
          <ul className="cmp-facts">
            <li>
              <span className="cmp-fact-label">turns</span>
              {countLine([
                [diff.turns.length, "paired", "same"],
                [diff.onlyInA.length, "only in A", "a"],
                [diff.onlyInB.length, "only in B", "b"],
              ])}
            </li>
            <li>
              <span className="cmp-fact-label">tools</span>
              {countLine([
                [diff.totals.toolAlignment.same, "same", "same"],
                [diff.totals.toolAlignment.changed, "changed", "changed"],
                [diff.totals.toolAlignment.onlyA, "only in A", "a"],
                [diff.totals.toolAlignment.onlyB, "only in B", "b"],
              ])}
            </li>
          </ul>
        </section>

        {diff.identical ? (
          <p className="pane-placeholder">
            No differences. Assistant prose is not compared, so the replies may still read
            differently.
          </p>
        ) : null}

        <Sets title="Files changed" sets={diff.totals.files} />
        <Sets title="Commands" sets={diff.totals.commands} />

        <section className="usage-block">
          <h3 className="usage-title">
            Turns <span className="usage-note">tool calls aligned within each pair</span>
          </h3>
          {diff.turns.length === 0 && diff.onlyInA.length === 0 && diff.onlyInB.length === 0 ? (
            <p className="pane-placeholder">Neither session recorded a prompt.</p>
          ) : (
            <ol className="turns">
              {diff.turns.map((turn, index) => (
                // Prompts repeat across turns, so position is the only stable identity.
                <PairedTurn key={`p${String(index)}`} turn={turn} position={index + 1} />
              ))}
              {diff.onlyInA.map((turn, index) => (
                <UnpairedTurn key={`a${String(index)}`} turn={turn} side="A" />
              ))}
              {diff.onlyInB.map((turn, index) => (
                <UnpairedTurn key={`b${String(index)}`} turn={turn} side="B" />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function Side(props: {
  label: "A" | "B";
  summary: SessionSummary;
  onOpen: (id: string) => void;
}): ReactElement {
  const { summary } = props;
  const models = summary.models.map((entry) => shortModel(entry.model));
  return (
    <button
      type="button"
      className={`cmp-side cmp-side--${props.label.toLowerCase()}`}
      onClick={() => {
        props.onOpen(summary.id);
      }}
    >
      <span className="cmp-side-label">{props.label}</span>
      <span className="cmp-side-title">{summary.title ?? "untitled session"}</span>
      <span className="cmp-side-meta">
        <span className="session-id">{shortId(summary.id)}</span>
        <span>{formatDuration(summary.durationMs)}</span>
        <span className="dot-sep">·</span>
        <span>{models.length > 0 ? models.join(", ") : "—"}</span>
      </span>
    </button>
  );
}

function Totals(props: { diff: SessionDiff }): ReactElement {
  const { totals } = props.diff;
  const filesA = props.diff.a.filesChanged.length;
  const filesB = props.diff.b.filesChanged.length;
  const count = (value: number): string => formatCount(value);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>metric</th>
          <th className="num cmp-a">A</th>
          <th className="num cmp-b">B</th>
          <th className="num">Δ</th>
        </tr>
      </thead>
      <tbody>
        <Row
          label="duration"
          a={formatDuration(totals.durationMs.a)}
          b={formatDuration(totals.durationMs.b)}
          delta={totals.durationMs.delta}
          format={formatDuration}
        />
        <Row
          label="prompts"
          a={count(totals.prompts.a)}
          b={count(totals.prompts.b)}
          delta={totals.prompts.delta}
          format={count}
        />
        <Row
          label="tool calls"
          a={count(totals.toolCalls.a)}
          b={count(totals.toolCalls.b)}
          delta={totals.toolCalls.delta}
          format={count}
        />
        <Row
          label="failed calls"
          a={count(totals.failedToolCalls.a)}
          b={count(totals.failedToolCalls.b)}
          delta={totals.failedToolCalls.delta}
          format={count}
        />
        <Row
          label="files changed"
          a={count(filesA)}
          b={count(filesB)}
          delta={filesB - filesA}
          format={count}
        />
        <Row
          label="tokens in"
          a={formatTokens(totals.usage.a.inputTokens)}
          b={formatTokens(totals.usage.b.inputTokens)}
          delta={totals.usage.delta.inputTokens}
          format={formatTokens}
        />
        <Row
          label="tokens out"
          a={formatTokens(totals.usage.a.outputTokens)}
          b={formatTokens(totals.usage.b.outputTokens)}
          delta={totals.usage.delta.outputTokens}
          format={formatTokens}
        />
      </tbody>
      <tfoot>
        <Row
          label="cost"
          a={formatCost(totals.costUsd.a)}
          b={formatCost(totals.costUsd.b)}
          delta={totals.costUsd.delta}
          format={(value) => formatCost(value)}
        />
      </tfoot>
    </table>
  );
}

function Row(props: {
  label: string;
  a: string;
  b: string;
  delta: number | null;
  format: (value: number) => string;
}): ReactElement {
  return (
    <tr>
      <td>{props.label}</td>
      <td className="num">{props.a}</td>
      <td className="num">{props.b}</td>
      <td className={`num delta delta--${deltaTone(props.delta)}`}>
        {formatDelta(props.delta, props.format)}
      </td>
    </tr>
  );
}

function Sets(props: { title: string; sets: SetDiff }): ReactElement {
  const groups = [
    { label: "only in A", marker: "-", tone: "a", values: props.sets.onlyA },
    { label: "only in B", marker: "+", tone: "b", values: props.sets.onlyB },
    { label: "in both", marker: "=", tone: "same", values: props.sets.both },
  ] as const;
  const total = groups.reduce((sum, group) => sum + group.values.length, 0);

  return (
    <section className="usage-block">
      <h3 className="usage-title">
        {props.title} <span className="usage-note">{formatCount(total)}</span>
      </h3>
      {total === 0 ? (
        <p className="pane-placeholder">Neither session touched any.</p>
      ) : (
        groups.map((group) =>
          group.values.length === 0 ? null : (
            <SetGroup
              key={group.label}
              label={group.label}
              marker={group.marker}
              tone={group.tone}
              values={group.values}
            />
          ),
        )
      )}
    </section>
  );
}

function SetGroup(props: {
  label: string;
  marker: string;
  tone: string;
  values: readonly string[];
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.values.length - SET_PREVIEW;
  const shown = expanded ? props.values : props.values.slice(0, SET_PREVIEW);

  return (
    <div className="set-group">
      <p className="set-label">
        {props.label} <span className="set-count">{formatCount(props.values.length)}</span>
      </p>
      <ul className="set-list">
        {shown.map((value) => (
          <li key={value} className={`set-item set-item--${props.tone}`}>
            <span className="set-marker">{props.marker}</span>
            <span className="set-value">{oneLine(value)}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          className="chip"
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "show fewer" : `show ${formatCount(hidden)} more`}
        </button>
      ) : null}
    </div>
  );
}

function PairedTurn(props: { turn: AlignedTurn; position: number }): ReactElement {
  const { turn } = props;
  const promptA = oneLine(turn.a.prompt);
  const promptB = oneLine(turn.b.prompt);

  return (
    <li className="turn">
      <p className="turn-head">
        turn {props.position}
        <span className="turn-similarity">similarity {turn.similarity.toFixed(2)}</span>
      </p>
      {promptA === promptB ? (
        <p className="turn-prompt">{promptA}</p>
      ) : (
        <>
          <p className="turn-prompt turn-prompt--a">
            <span className="turn-side">A</span>
            {promptA}
          </p>
          <p className="turn-prompt turn-prompt--b">
            <span className="turn-side">B</span>
            {promptB}
          </p>
        </>
      )}
      <ul className="tool-lines">
        {turn.tools.map((entry, index) => (
          // Identical calls repeat inside a turn, so position is the identity.
          <ToolLine key={`t${String(index)}`} entry={entry} />
        ))}
      </ul>
    </li>
  );
}

function UnpairedTurn(props: { turn: SessionTurn; side: "A" | "B" }): ReactElement {
  const tone = props.side === "A" ? "a" : "b";
  const marker = props.side === "A" ? "-" : "+";
  return (
    <li className="turn">
      <p className="turn-head">turn only in {props.side}</p>
      <p className={`turn-prompt turn-prompt--${tone}`}>
        <span className="turn-side">{props.side}</span>
        {oneLine(props.turn.prompt)}
      </p>
      <ul className="tool-lines">
        {props.turn.toolCalls.map((call, index) => (
          <li key={`c${String(index)}`} className={`tool-line tool-line--${tone}`}>
            <span className="tool-marker">{marker}</span>
            <span className="tool-name">{call.name}</span>
            <span className="tool-detail">{detailOf(call)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function ToolLine(props: { entry: ToolAlignment }): ReactElement {
  const { entry } = props;
  if (entry.status === "only-a") {
    return (
      <li className="tool-line tool-line--a">
        <span className="tool-marker">-</span>
        <span className="tool-name">{entry.a.name}</span>
        <span className="tool-detail">{detailOf(entry.a)}</span>
      </li>
    );
  }
  if (entry.status === "only-b") {
    return (
      <li className="tool-line tool-line--b">
        <span className="tool-marker">+</span>
        <span className="tool-name">{entry.b.name}</span>
        <span className="tool-detail">{detailOf(entry.b)}</span>
      </li>
    );
  }
  if (entry.status === "same") {
    return (
      <li className="tool-line tool-line--same">
        <span className="tool-marker">=</span>
        <span className="tool-name">{entry.a.name}</span>
        <span className="tool-detail">{detailOf(entry.a)}</span>
      </li>
    );
  }
  // Changed calls usually differ deep inside an argument, so both sides show.
  if (entry.a.detail === entry.b.detail) {
    return (
      <li className="tool-line tool-line--changed">
        <span className="tool-marker">~</span>
        <span className="tool-name">{entry.a.name}</span>
        <span className="tool-detail">
          {detailOf(entry.a)} <span className="tool-note">(inputs differ)</span>
        </span>
      </li>
    );
  }
  return (
    <li className="tool-line tool-line--changed">
      <span className="tool-marker">~</span>
      <span className="tool-name">{entry.a.name}</span>
      <span className="tool-detail">
        <span className="tool-side tool-side--a">A</span>
        {detailOf(entry.a)}
        <br />
        <span className="tool-side tool-side--b">B</span>
        {detailOf(entry.b)}
      </span>
    </li>
  );
}

function detailOf(call: ToolCall): string {
  return call.detail === null ? "" : oneLine(call.detail);
}

/** The first entry always shows; a zero in any later one is not worth a column. */
function countLine(parts: readonly (readonly [number, string, string])[]): ReactElement {
  const shown = parts.filter(([count], index) => index === 0 || count > 0);
  return (
    <span className="cmp-fact-values">
      {shown.map(([count, label, tone], index) => (
        <span key={label} className={`cmp-count cmp-count--${tone}`}>
          {index > 0 ? <span className="dot-sep">·</span> : null}
          {formatCount(count)} {label}
        </span>
      ))}
    </span>
  );
}
