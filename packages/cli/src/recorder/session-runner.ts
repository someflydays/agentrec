import { execFileSync } from "node:child_process";
import type { SessionMeta, SessionStore } from "@agentrec/core";
import { cliVersion } from "../version.js";
import { runChildSession } from "./child-session.js";
import { mapHookPayload } from "./hook-events.js";
import { commandSupportsHooks, type HookInjection, injectHookSettings } from "./hooks-settings.js";
import { startIngestServer } from "./ingest-server.js";
import { runPtySession } from "./pty-session.js";
import { TranscriptTailer } from "./transcript-tailer.js";

/**
 * One lifecycle for every recorded session, whoever asked for it: create the
 * session, stand up the hook ingest endpoint, inject the hook settings, start
 * the transcript tailer as soon as a hook names the transcript, and close all
 * three in order once the agent exits. Only how the agent is executed differs.
 *
 * - "pty": attached to this process's terminal, cast recorded at its size.
 * - "headless": a piped child process nobody is watching, cast at a fixed size.
 */
export type SessionMode = "pty" | "headless";

/** recorder.error source used when the agent could not be started at all. */
const ERROR_SOURCE: Record<SessionMode, string> = { pty: "pty", headless: "spawn" };

export interface SessionRunOptions {
  store: SessionStore;
  /** argv as the user asked for it, without anything the recorder injects. */
  command: string[];
  cwd: string;
  mode: SessionMode;
  /** The running CLI entry point, which the injected hook command re-invokes. */
  cliEntry: string;
  /** Injects Claude Code hooks when the command is a claude invocation (default true). */
  hooks?: boolean;
  gitBranch?: string;
  forkedFrom?: { sessionId: string; seq: number };
  /**
   * Transcript uuids this session inherited from the conversation it resumes.
   * Their assistant text and token usage were already recorded against the
   * parent, so the tailer must not attribute them to this session as well.
   */
  inheritedUuids?: ReadonlySet<string>;
  /** Called once the recording exists, just before the agent is started. */
  onStart?: (id: string) => void;
}

export interface RecordedSession {
  id: string;
  /**
   * Resolves with the agent's exit code once the recording has been closed.
   * Rejects only when the agent could not be run at all — the recording is
   * closed first, with the reason in it.
   */
  done: Promise<number | null>;
}

export function currentGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts recording and resolves as soon as the agent is running, so a caller
 * that answers over HTTP can name the new session before it finishes. Callers
 * that own a terminal simply await `done`.
 */
export async function startRecordedSession(options: SessionRunOptions): Promise<RecordedSession> {
  const { store, command, cwd, mode } = options;
  store.ensure();
  const meta: Omit<SessionMeta, "formatVersion"> = {
    id: store.newSessionId(),
    agent: "claude-code",
    command,
    cwd,
    startedAt: new Date().toISOString(),
    ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
    recorderVersion: cliVersion(),
    ...(options.forkedFrom !== undefined ? { forkedFrom: options.forkedFrom } : {}),
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
        tailer = new TranscriptTailer(mapped.transcriptPath, writer, {
          ...(options.inheritedUuids !== undefined ? { skipUuids: options.inheritedUuids } : {}),
        });
        tailer.start();
      }
      for (const event of mapped.events) writer.event(event.type, event.data);
    },
    onError: (message) => {
      writer.event("recorder.error", { source: "ingest", message });
    },
  });

  const injection: HookInjection =
    options.hooks !== false && commandSupportsHooks(command)
      ? injectHookSettings(command, process.execPath, options.cliEntry)
      : { argv: command };
  if (injection.warning !== undefined) {
    writer.event("recorder.error", { source: "hooks", message: injection.warning });
    process.stderr.write(`agentrec: ${injection.warning}\n`);
  }

  options.onStart?.(meta.id);

  const run = {
    command: injection.argv,
    title: command.join(" "),
    cwd,
    env: {
      ...process.env,
      AGENTREC_INGEST_URL: ingest.url,
      AGENTREC_INGEST_TOKEN: ingest.token,
    },
    writer,
  };
  const running = mode === "pty" ? runPtySession(run) : runChildSession(run);

  const done = (async (): Promise<number | null> => {
    try {
      const exitCode = await running;
      tailer?.stop();
      writer.end(exitCode);
      return exitCode;
    } catch (error) {
      writer.event("recorder.error", { source: ERROR_SOURCE[mode], message: messageOf(error) });
      writer.end(null);
      throw error;
    } finally {
      tailer?.stop();
      await ingest.close();
    }
  })();

  return { id: meta.id, done };
}
