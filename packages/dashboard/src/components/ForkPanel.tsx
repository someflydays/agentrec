import type { CapabilitiesResponse, ForkPoint } from "@agentrec/core/browser";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { runFork } from "../api";
import { errorText } from "../lib/errors";
import { forkCommand } from "../lib/fork";
import { formatOffset, shortId } from "../lib/format";
import { Modal } from "./Modal";

interface ForkPanelProps {
  sessionId: string;
  point: ForkPoint;
  capabilities: CapabilitiesResponse | null;
  onClose: () => void;
  onForked: (sessionId: string) => void;
}

export function ForkPanel(props: ForkPanelProps): ReactElement {
  const { point, sessionId } = props;
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const canRun = props.capabilities?.fork === true;
  const command = forkCommand(sessionId, point.seq, prompt);
  const ready = prompt.trim().length > 0;

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const response = await runFork(
        sessionId,
        { seq: point.seq, prompt: prompt.trim() },
        props.capabilities?.token ?? "",
      );
      props.onForked(response.sessionId);
    } catch (cause) {
      setError(errorText(cause));
      setRunning(false);
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setError("The clipboard is not available here — select the command below and copy it.");
    }
  };

  return (
    <Modal title="Fork from here" onClose={props.onClose}>
      <div className="modal-body">
        <section className="fork-origin">
          <p className="fork-origin-meta">
            <span className="mono">#{point.seq}</span>
            <span className="dot-sep">·</span>
            <span className="mono">{formatOffset(point.t)}</span>
            <span className="dot-sep">·</span>
            <span className="mono">{point.type}</span>
            <span className="dot-sep">·</span>
            <span className="mono">{shortId(sessionId)}</span>
          </p>
          <pre className="code-block code-block--flush">{point.preview}</pre>
        </section>

        <label className="field" htmlFor="fork-prompt">
          <span className="field-label">New instruction</span>
          <textarea
            id="fork-prompt"
            ref={promptRef}
            className="field-input"
            rows={4}
            value={prompt}
            disabled={running}
            spellCheck={false}
            placeholder="What should the agent do differently from this point?"
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
          />
        </label>

        {canRun ? null : (
          <p className="fork-note">
            This server is read-only. Start it with{" "}
            <code className="mono">agentrec ui --allow-fork</code> to run forks straight from the
            dashboard; until then, copy the command below.
          </p>
        )}

        <section className="fork-command">
          <p className="field-label">CLI equivalent</p>
          <pre className="code-block code-block--flush">{command}</pre>
        </section>

        {error !== null ? (
          <p className="inline-error">
            <span>{error}</span>
            <button
              type="button"
              className="inline-error-close"
              onClick={() => {
                setError(null);
              }}
            >
              dismiss
            </button>
          </p>
        ) : null}

        {running ? (
          <p className="fork-progress">Starting the agent — this session will open when it does.</p>
        ) : null}
      </div>

      <footer className="modal-foot">
        <button type="button" className="player-button" onClick={props.onClose} disabled={running}>
          Cancel
        </button>
        <span className="modal-foot-gap" />
        <button
          type="button"
          className="player-button"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        {canRun ? (
          <button
            type="button"
            className="player-button player-button--primary"
            disabled={!ready || running}
            title={ready ? "Fork and rerun from this event" : "Write the new instruction first"}
            onClick={() => {
              void submit();
            }}
          >
            {running ? "Forking…" : "Run fork"}
          </button>
        ) : null}
      </footer>
    </Modal>
  );
}
