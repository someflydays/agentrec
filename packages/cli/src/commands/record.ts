import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type SessionMeta, SessionStore, summarizeSession } from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { ABSENT, formatCost, formatDuration, formatTokenCount } from "../format.js";
import { mapHookPayload } from "../recorder/hook-events.js";
import { commandSupportsHooks, hookSettingsArgs } from "../recorder/hooks-settings.js";
import { startIngestServer } from "../recorder/ingest-server.js";
import { runPtySession } from "../recorder/pty-session.js";
import { TranscriptTailer } from "../recorder/transcript-tailer.js";
import { cliVersion } from "../version.js";

const DEFAULT_COMMAND = ["claude"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentGitBranch(cwd: string): string | undefined {
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

/** The running CLI entry point, which the injected hook command re-invokes. */
function cliEntryPath(): string {
  return process.argv[1] ?? fileURLToPath(import.meta.url);
}

function shortId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function printSummary(store: SessionStore, id: string): void {
  const summary = summarizeSession(store.readMeta(id), store.readEvents(id));
  const { inputTokens, outputTokens } = summary.totalUsage;
  const parts = [
    summary.durationMs === null ? ABSENT : formatDuration(summary.durationMs),
    plural(summary.prompts, "prompt"),
    plural(summary.toolCalls, "tool"),
    `${formatTokenCount(inputTokens + outputTokens)} tokens`,
    formatCost(summary.totalCostUsd),
  ];
  // Newlines stay outside pc.dim so the reset code lands before them.
  process.stderr.write(`\n${pc.dim(`● recorded ${shortId(id)} · ${parts.join(" · ")}`)}\n`);
  process.stderr.write(`${pc.dim("  replay: agentrec ui")}\n`);
}

async function record(command: string[], injectHooks: boolean): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("recording requires an interactive terminal");
  }

  const store = new SessionStore();
  store.ensure();
  const cwd = process.cwd();
  const branch = currentGitBranch(cwd);
  const meta: Omit<SessionMeta, "formatVersion"> = {
    id: store.newSessionId(),
    agent: "claude-code",
    command,
    cwd,
    startedAt: new Date().toISOString(),
    ...(branch !== undefined ? { gitBranch: branch } : {}),
    recorderVersion: cliVersion(),
  };
  const writer = store.createSession(meta);

  let tailer: TranscriptTailer | undefined;
  const applyHookPayload = (payload: unknown): void => {
    const mapped = mapHookPayload(payload);
    if (mapped.agentSessionId !== undefined && writer.sessionMeta.agentSessionId === undefined) {
      writer.updateMeta({ agentSessionId: mapped.agentSessionId });
    }
    if (mapped.transcriptPath !== undefined && tailer === undefined) {
      tailer = new TranscriptTailer(mapped.transcriptPath, writer);
      tailer.start();
    }
    for (const event of mapped.events) writer.event(event.type, event.data);
  };

  const ingest = await startIngestServer({
    onPayload: applyHookPayload,
    onError: (message) => {
      writer.event("recorder.error", { source: "ingest", message });
    },
  });

  const argv =
    injectHooks && commandSupportsHooks(command)
      ? [...command, ...hookSettingsArgs(process.execPath, cliEntryPath())]
      : command;

  process.stderr.write(`${pc.dim(`● agentrec recording ${shortId(meta.id)}`)}\n`);

  try {
    const exitCode = await runPtySession({
      command: argv,
      title: command.join(" "),
      cwd,
      env: {
        ...process.env,
        AGENTREC_INGEST_URL: ingest.url,
        AGENTREC_INGEST_TOKEN: ingest.token,
      },
      writer,
    });
    tailer?.stop();
    writer.end(exitCode);
    process.exitCode = exitCode;
    printSummary(store, meta.id);
  } catch (error) {
    const message = messageOf(error);
    writer.event("recorder.error", { source: "pty", message });
    writer.end(null);
    throw new Error(`could not record "${command.join(" ")}": ${message}`);
  } finally {
    tailer?.stop();
    await ingest.close();
  }
}

export function registerRecordCommand(program: Command): void {
  program
    .command("record")
    .description("Record an agent session in a pseudoterminal")
    .argument("[command...]", "command to record (default: claude)")
    .option("--no-hooks", "do not inject Claude Code hooks")
    // Everything after the recorded command belongs to it, not to us.
    .passThroughOptions()
    .action(async (command: string[], options: { hooks: boolean }) => {
      await record(command.length > 0 ? command : DEFAULT_COMMAND, options.hooks);
    });
}
