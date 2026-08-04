import type { SessionDetailResponse } from "@agentrec/core/browser";
import type { ReactElement } from "react";
import {
  formatCost,
  formatDuration,
  formatExitCode,
  formatTimestamp,
  formatTokens,
  shortId,
  shortModel,
} from "../lib/format";

interface SessionHeaderProps {
  detail: SessionDetailResponse;
  onCompare: () => void;
  onOpenSession: (id: string, seq?: number) => void;
}

export function SessionHeader(props: SessionHeaderProps): ReactElement {
  const { meta, summary, live } = props.detail;
  const elapsed = live ? Date.now() - Date.parse(meta.startedAt) : summary.durationMs;
  const models = summary.models.map((model) => shortModel(model.model));
  const origin = meta.forkedFrom;

  return (
    <header className="session-head">
      <div className="session-head-top">
        <h1 className="session-title">{meta.title ?? "untitled session"}</h1>
        {live ? <span className="live-badge">live</span> : null}
        <span className="session-id" title={meta.id}>
          {shortId(meta.id)}
        </span>
        {origin !== undefined ? (
          <button
            type="button"
            className="lineage"
            title={`Open ${origin.sessionId} at event #${String(origin.seq)}`}
            onClick={() => {
              props.onOpenSession(origin.sessionId, origin.seq);
            }}
          >
            forked from {shortId(origin.sessionId)} at #{origin.seq}
          </button>
        ) : null}
        <button type="button" className="chip" onClick={props.onCompare}>
          Compare
        </button>
        <span className="session-loc">
          {/* rtl truncates the uninteresting head of the path; bdi keeps it readable. */}
          <span className="session-cwd" title={meta.cwd}>
            <bdi>{meta.cwd}</bdi>
          </span>
          {meta.gitBranch !== undefined ? (
            <span className="session-branch">{meta.gitBranch}</span>
          ) : null}
        </span>
      </div>
      <dl className="stats">
        <Stat label="started" value={formatTimestamp(meta.startedAt)} />
        <Stat label="duration" value={formatDuration(elapsed)} />
        <Stat
          label="exit"
          value={live ? "running" : formatExitCode(meta.exitCode)}
          tone={!live && typeof meta.exitCode === "number" && meta.exitCode !== 0 ? "bad" : "plain"}
        />
        <Stat label="prompts" value={String(summary.prompts)} />
        <Stat label="tools" value={String(summary.toolCalls)} />
        <Stat
          label="tokens"
          value={`${formatTokens(summary.totalUsage.inputTokens + summary.totalUsage.cacheReadInputTokens)} in · ${formatTokens(summary.totalUsage.outputTokens)} out`}
        />
        <Stat label="cost" value={formatCost(summary.totalCostUsd)} tone="accent" />
        <Stat label="models" value={models.length > 0 ? models.join(", ") : "—"} />
      </dl>
    </header>
  );
}

function Stat(props: {
  label: string;
  value: string;
  tone?: "plain" | "accent" | "bad";
}): ReactElement {
  return (
    <div className="stat">
      <dt className="stat-label">{props.label}</dt>
      <dd className={`stat-value stat-value--${props.tone ?? "plain"}`}>{props.value}</dd>
    </div>
  );
}
