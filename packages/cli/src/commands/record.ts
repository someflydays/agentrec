import { fileURLToPath } from "node:url";
import { SessionStore, summarizeSession } from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { ABSENT, formatCost, formatDuration, formatTokenCount } from "../format.js";
import { currentGitBranch, startRecordedSession } from "../recorder/session-runner.js";

const DEFAULT_COMMAND = ["claude"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const cwd = process.cwd();
  const branch = currentGitBranch(cwd);
  const session = await startRecordedSession({
    store,
    command,
    cwd,
    mode: "pty",
    cliEntry: cliEntryPath(),
    hooks: injectHooks,
    ...(branch !== undefined ? { gitBranch: branch } : {}),
    onStart: (id) => {
      process.stderr.write(`${pc.dim(`● agentrec recording ${shortId(id)}`)}\n`);
    },
  });

  let exitCode: number | null;
  try {
    exitCode = await session.done;
  } catch (error) {
    throw new Error(`could not record "${command.join(" ")}": ${messageOf(error)}`);
  }
  if (exitCode !== null) process.exitCode = exitCode;
  printSummary(store, session.id);
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
