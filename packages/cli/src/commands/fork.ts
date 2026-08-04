import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type SessionEvent, SessionStore } from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { formatDuration, truncate } from "../format.js";
import {
  checkForkSupport,
  claudeVersion,
  cutIndexForEvent,
  type ForkPoint,
  forkPoints,
  newAgentSessionId,
  planFork,
  plannedUuids,
  readTranscriptLines,
  resolveTranscriptPath,
  toolCallPreview,
  writeForkedTranscript,
} from "../recorder/fork.js";
import { currentGitBranch, startRecordedSession } from "../recorder/session-runner.js";

const MAX_PREVIEW_CHARS = 64;

const GATE_NOTICE = [
  "fork is experimental and must be run with --experimental.",
  "",
  "It reads Claude Code's own transcript files and writes a truncated copy of one.",
  "That format is an internal detail, not a published contract, so a Claude Code",
  "release can break forking without warning. The original session and its",
  "transcript are only ever read.",
  "",
  "Re-run with --experimental, and add --dry-run to see the plan before it runs.",
].join("\n");

const WORKING_TREE_NOTE = "the fork replays the conversation only; the working tree is not rewound";

interface ForkOptions {
  at?: string;
  list?: boolean;
  prompt?: string;
  experimental?: boolean;
  dryRun?: boolean;
}

function shortId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

function oneLine(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), MAX_PREVIEW_CHARS);
}

function field(label: string, value: string): void {
  console.log(`  ${pc.dim(label.padEnd(15))} ${value}`);
}

function printForkPoints(points: ForkPoint[]): void {
  if (points.length === 0) {
    console.log(
      "No prompts, assistant replies or tool calls were recorded, so there is nothing to fork from.",
    );
    return;
  }
  const rows = points.map((point) => [
    String(point.seq),
    formatDuration(point.t),
    point.kind,
    oneLine(point.preview),
  ]);
  const headers = ["SEQ", "AT", "KIND", "PREVIEW"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  console.log(pc.dim(render(headers)));
  for (const row of rows) console.log(render(row));
}

function eventWithSeq(events: SessionEvent[], seq: number): SessionEvent {
  const event = events.find((candidate) => candidate.seq === seq);
  if (event === undefined) {
    throw new Error(
      `no event with seq ${seq} in this session (run with --list to see fork points)`,
    );
  }
  return event;
}

/** The dry run prints a command the reader can paste, so spaces are quoted. */
function shellish(command: string[]): string {
  return command.map((arg) => (/[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function describeEvent(event: SessionEvent): string {
  const at = `seq ${event.seq} · ${formatDuration(event.t)} · ${event.type}`;
  if (event.type === "prompt") return `${at} · "${oneLine(event.data.text)}"`;
  if (event.type === "assistant.text") return `${at} · "${oneLine(event.data.text)}"`;
  if (event.type === "tool.start") {
    const call = oneLine(toolCallPreview(event.data.name, event.data.input));
    // The cut for a tool call lands before it, which the label has to say.
    return `${at} · ${call} · resumes just before this call`;
  }
  return at;
}

async function fork(session: string, options: ForkOptions): Promise<void> {
  const store = new SessionStore();
  const id = store.resolveId(session);
  const meta = store.readMeta(id);

  if (meta.agentSessionId === undefined) {
    throw new Error(
      `session ${shortId(id)} has no agent session id, so it has no transcript to fork (it was recorded without hooks)`,
    );
  }
  const transcriptPath = resolveTranscriptPath(meta);
  if (transcriptPath === null) {
    throw new Error(
      `no Claude Code transcript found for session ${shortId(id)} (agent session ${meta.agentSessionId}). Claude Code removes old transcripts, and a fork needs the original conversation.`,
    );
  }

  const lines = readTranscriptLines(transcriptPath);
  const unsupported = checkForkSupport(lines, claudeVersion());
  if (unsupported !== null) throw new Error(unsupported);

  const events = store.readEvents(id);
  if (options.list === true) {
    printForkPoints(forkPoints(events));
    return;
  }
  if (options.at === undefined) {
    throw new Error("fork needs --at <seq>; run with --list to see the fork points");
  }
  const seq = Number.parseInt(options.at, 10);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`--at expects an event seq, got "${options.at}"`);
  }

  const event = eventWithSeq(events, seq);
  const cutIndex = cutIndexForEvent(lines, event, meta.startedAt);
  if (cutIndex === null || cutIndex < 0) {
    throw new Error(`could not map seq ${seq} onto a line of ${transcriptPath}`);
  }

  const newSessionId = newAgentSessionId();
  const plan = planFork(lines, { at: cutIndex, newSessionId });
  if (plan.headUuid === null) {
    throw new Error(
      `nothing before seq ${seq} forms a resumable conversation; pick a later fork point with --list`,
    );
  }

  const command = [
    "claude",
    "--resume",
    newSessionId,
    "--fork-session",
    ...(options.prompt !== undefined ? ["-p", options.prompt] : []),
  ];
  const projectDir = dirname(transcriptPath);

  if (options.dryRun === true) {
    console.log(pc.bold("fork plan"), pc.dim("(dry run)"));
    field("source", `${shortId(id)}${meta.title === undefined ? "" : ` · ${meta.title}`}`);
    field("transcript", `${transcriptPath} (${lines.length} lines)`);
    field("cut at", describeEvent(event));
    field("transcript line", `${plan.cutIndex + 1} of ${lines.length}`);
    field("keeps", `${plan.lines.length} lines (${plan.dropped} dropped to reach a valid head)`);
    field("head", plan.headUuid);
    field("would write", `${projectDir}/${newSessionId}.jsonl`);
    field("would run", shellish(command));
    console.log(pc.dim(`\n  nothing was written; ${WORKING_TREE_NOTE}`));
    return;
  }

  const written = writeForkedTranscript(plan.lines, newSessionId, projectDir);
  process.stderr.write(
    `${pc.dim(`● forked ${shortId(id)} at seq ${seq} · ${plan.lines.length} lines → ${written}`)}\n`,
  );
  process.stderr.write(`${pc.dim(`  ${WORKING_TREE_NOTE}`)}\n`);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("recording the fork requires an interactive terminal");
  }
  const branch = currentGitBranch(meta.cwd);
  const recording = await startRecordedSession({
    store,
    command,
    cwd: meta.cwd,
    mode: "pty",
    cliEntry: process.argv[1] ?? fileURLToPath(import.meta.url),
    forkedFrom: { sessionId: id, seq },
    // The replayed conversation is already recorded against the parent.
    inheritedUuids: plannedUuids(plan.lines),
    ...(branch !== undefined ? { gitBranch: branch } : {}),
    onStart: (forkId) => {
      process.stderr.write(`${pc.dim(`● agentrec recording ${shortId(forkId)}`)}\n`);
    },
  });

  let exitCode: number | null;
  try {
    exitCode = await recording.done;
  } catch (error) {
    throw new Error(
      `could not record the fork: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (exitCode !== null) process.exitCode = exitCode;
  process.stderr.write(
    `\n${pc.dim(`● recorded ${shortId(recording.id)} · replay: agentrec ui`)}\n`,
  );
}

export function registerForkCommand(program: Command): void {
  program
    .command("fork")
    .description("Replay a recorded session from one of its events with a new instruction")
    .argument("<session>", "session id or unique id prefix")
    .option("--at <seq>", "event seq to fork from")
    .option("--list", "list the events this session can be forked from")
    .option("--prompt <text>", "instruction to send after forking (default: interactive)")
    .option("--experimental", "acknowledge that this depends on Claude Code internals")
    .option("--dry-run", "print the plan without writing or launching anything")
    .action(async (session: string, options: ForkOptions) => {
      if (options.experimental !== true) {
        console.error(GATE_NOTICE);
        process.exitCode = 1;
        return;
      }
      await fork(session, options);
    });
}
