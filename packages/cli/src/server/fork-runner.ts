import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CastWriter, type SessionMeta, type SessionStore } from "@agentrec/core";
import {
  checkForkSupport,
  claudeVersion,
  cutIndexForEvent,
  newAgentSessionId,
  planFork,
  readTranscriptLines,
  resolveTranscriptPath,
  writeForkedTranscript,
} from "../recorder/fork.js";
import { mapHookPayload } from "../recorder/hook-events.js";
import { hookSettingsArgs } from "../recorder/hooks-settings.js";
import { startIngestServer } from "../recorder/ingest-server.js";
import { TranscriptTailer } from "../recorder/transcript-tailer.js";
import { cliVersion } from "../version.js";

const AGENT_FILE = "claude";

/** A print-mode fork owns no terminal, so its cast is written at a fixed size. */
const CAST_COLS = 80;
const CAST_ROWS = 24;

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

interface RecordOptions {
  store: SessionStore;
  /** argv as the user would have typed it, without the injected hook settings. */
  command: string[];
  cwd: string;
  forkedFrom: { sessionId: string; seq: number };
}

async function record(options: RecordOptions): Promise<ForkLaunch> {
  const { store, command, cwd } = options;
  store.ensure();
  const meta: Omit<SessionMeta, "formatVersion"> = {
    id: store.newSessionId(),
    agent: "claude-code",
    command,
    cwd,
    startedAt: new Date().toISOString(),
    recorderVersion: cliVersion(),
    forkedFrom: options.forkedFrom,
  };
  const writer = store.createSession(meta);

  let tailer: TranscriptTailer | undefined;
  const ingest = await startIngestServer({
    onPayload: (payload) => {
      const mapped = mapHookPayload(payload);
      if (mapped.agentSessionId !== undefined && writer.sessionMeta.agentSessionId === undefined) {
        writer.updateMeta({ agentSessionId: mapped.agentSessionId });
      }
      if (mapped.transcriptPath !== undefined && tailer === undefined) {
        tailer = new TranscriptTailer(mapped.transcriptPath, writer);
        tailer.start();
      }
      for (const event of mapped.events) writer.event(event.type, event.data);
    },
    onError: (message) => {
      writer.event("recorder.error", { source: "ingest", message });
    },
  });

  const cast = new CastWriter(writer.castPath, {
    width: CAST_COLS,
    height: CAST_ROWS,
    title: command.join(" "),
    timestamp: Math.floor(Date.now() / 1000),
  });

  // The prompt came from a browser and is handed over as one argv element:
  // spawn runs the agent directly, with no shell anywhere to interpret it.
  const child = spawn(
    AGENT_FILE,
    [...command.slice(1), ...hookSettingsArgs(process.execPath, cliEntry())],
    {
      cwd,
      env: {
        ...process.env,
        AGENTREC_INGEST_URL: ingest.url,
        AGENTREC_INGEST_TOKEN: ingest.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const tee = (stream: Readable | null): void => {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      cast.output(writer.elapsedMs(), chunk);
    });
  };
  tee(child.stdout);
  tee(child.stderr);

  let closed = false;
  const done = new Promise<void>((resolve) => {
    const finish = async (exitCode: number | null): Promise<void> => {
      if (closed) return;
      closed = true;
      tailer?.stop();
      await cast.close();
      writer.end(exitCode);
      await ingest.close();
      resolve();
    };
    child.once("error", (error: Error) => {
      writer.event("recorder.error", { source: "spawn", message: error.message });
      void finish(null);
    });
    child.once("close", (exitCode) => {
      void finish(exitCode);
    });
  });

  return { sessionId: meta.id, done };
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

  return record({
    store,
    command: [AGENT_FILE, "--resume", agentSessionId, "--fork-session", "-p", prompt],
    cwd: meta.cwd,
    forkedFrom: { sessionId, seq },
  });
}
