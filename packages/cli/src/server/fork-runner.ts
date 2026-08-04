import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionStore } from "@agentrec/core";
import {
  checkForkSupport,
  claudeVersion,
  cutIndexForEvent,
  newAgentSessionId,
  planFork,
  plannedUuids,
  readTranscriptLines,
  resolveTranscriptPath,
  writeForkedTranscript,
} from "../recorder/fork.js";
import { startRecordedSession } from "../recorder/session-runner.js";

const AGENT_FILE = "claude";

export interface ForkLaunchRequest {
  store: SessionStore;
  /** Resolved id of the session being forked. */
  sessionId: string;
  seq: number;
  prompt: string;
}

export interface ForkLaunch {
  /** Id of the new recording, known as soon as the agent has been spawned. */
  sessionId: string;
  /** Settles when the agent has exited and the recording has been closed. */
  done: Promise<void>;
}

export type ForkLauncher = (request: ForkLaunchRequest) => Promise<ForkLaunch>;

/** A fork that cannot be run as asked; `status` is answered to the caller verbatim. */
export class ForkRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The running CLI entry point, which the injected hook command re-invokes. */
function cliEntry(): string {
  return process.argv[1] ?? fileURLToPath(import.meta.url);
}

/**
 * The dashboard's fork: the same plan `agentrec fork` makes, launched
 * non-interactively with the browser's prompt in print mode. Everything up to
 * the spawn is awaited so the caller can answer with a session id that is
 * already recording; the agent itself runs on well past the response.
 */
export async function launchFork(request: ForkLaunchRequest): Promise<ForkLaunch> {
  const { store, sessionId, seq, prompt } = request;
  const meta = store.readMeta(sessionId);
  if (meta.agentSessionId === undefined) {
    throw new ForkRequestError(
      400,
      "this session was recorded without hooks, so it has no agent transcript to fork",
    );
  }
  const transcriptPath = resolveTranscriptPath(meta);
  if (transcriptPath === null) {
    throw new ForkRequestError(
      400,
      `Claude Code no longer has a transcript for agent session ${meta.agentSessionId}`,
    );
  }

  const lines = readTranscriptLines(transcriptPath);
  const unsupported = checkForkSupport(lines, claudeVersion());
  if (unsupported !== null) throw new ForkRequestError(400, unsupported);

  const event = store.readEvents(sessionId).find((candidate) => candidate.seq === seq);
  if (event === undefined) {
    throw new ForkRequestError(400, `this session has no event with seq ${seq}`);
  }
  const cutIndex = cutIndexForEvent(lines, event, meta.startedAt);
  if (cutIndex === null || cutIndex < 0) {
    throw new ForkRequestError(400, `seq ${seq} does not map onto a line of the agent transcript`);
  }

  const agentSessionId = newAgentSessionId();
  const plan = planFork(lines, { at: cutIndex, newSessionId: agentSessionId });
  if (plan.headUuid === null) {
    throw new ForkRequestError(
      400,
      `nothing before seq ${seq} forms a resumable conversation; pick a later fork point`,
    );
  }
  writeForkedTranscript(plan.lines, agentSessionId, dirname(transcriptPath));

  // The prompt came from a browser and is handed over as one argv element; the
  // headless mode spawns the agent directly, with no shell to interpret it.
  const session = await startRecordedSession({
    store,
    command: [AGENT_FILE, "--resume", agentSessionId, "--fork-session", "-p", prompt],
    cwd: meta.cwd,
    mode: "headless",
    cliEntry: cliEntry(),
    forkedFrom: { sessionId, seq },
    // The replayed conversation is already recorded against the parent.
    inheritedUuids: plannedUuids(plan.lines),
  });
  return { sessionId: session.id, done: session.done.then(() => undefined) };
}
