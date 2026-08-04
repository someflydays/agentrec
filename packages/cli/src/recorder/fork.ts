import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agentrec/core";
import { asNonEmptyString, asRecord } from "./json.js";

/**
 * Forking rewrites nothing: it reads a Claude Code transcript, writes a
 * truncated copy under a fresh session id, and resumes that copy. None of this
 * is a published contract, so every assumption it leans on is written down
 * here and checked before anything is written.
 *
 * 1. Transcripts live at <config>/projects/<slug>/<session-uuid>.jsonl, where
 *    <slug> is the session's cwd with every character outside [a-zA-Z0-9]
 *    replaced by "-" (verified against Claude Code 2.1.220: "/a/b c_d.e" maps
 *    to "-a-b-c-d-e"). The slug is only a fast path — when it misses, the
 *    project directories are scanned for the session file, which survives a
 *    change to the slug rule.
 * 2. A line is part of the conversation iff it has a string `uuid`; those lines
 *    chain through `parentUuid` (null at the root) and always appear after
 *    their parent. Everything else (ai-title, last-prompt, mode, file-history,
 *    queue-operation, bridge-session) is per-session metadata with no uuid.
 * 3. Resuming replays the conversation by walking the parent chain back from
 *    the file's last conversation line, so a valid prefix is one where no kept
 *    line references a dropped parent and the last kept line is the head we
 *    intend to fork from.
 * 4. Each `tool_use` block in an assistant line is answered by a `tool_result`
 *    block in a later user line. A prefix that ends with an unanswered
 *    `tool_use` is not a resumable conversation, so the cut walks back to the
 *    last line where nothing is outstanding.
 * 5. Sidechain (subagent) lines hang off the main thread as a separate branch
 *    and are never replayed by a resume from a main-thread head. They are kept
 *    for fidelity but can never become the head.
 */

/** The transcript shape below was verified against this Claude Code major. */
const SUPPORTED_CLAUDE_MAJOR = 2;

/** Line fields naming the session; both spellings occur on the same line. */
const SESSION_ID_FIELDS = ["sessionId", "session_id"] as const;

/** Metadata-line fields that point at a conversation line's uuid. */
const UUID_REFERENCE_FIELDS = ["leafUuid", "messageId", "snapshotMessageId"] as const;

export type TranscriptLine = Record<string, unknown>;

export interface ForkCutPoint {
  /** Inclusive: an index into the lines passed to planFork, or a line uuid. */
  at: number | string;
  /** Every kept line's session id is rewritten to this. */
  newSessionId: string;
}

export interface ForkPlan {
  /** The truncated, session-rewritten prefix, ready to write. */
  lines: TranscriptLine[];
  /** Index the cut resolved to, before the prefix was made valid. */
  cutIndex: number;
  /** Lines at or before the cut that the prefix could not keep. */
  dropped: number;
  /** uuid of the last kept conversation line — what the fork resumes from. */
  headUuid: string | null;
}

export interface ForkPoint {
  seq: number;
  t: number;
  kind: "prompt" | "assistant";
  preview: string;
}

export interface ForkSource {
  agentSessionId?: string;
  cwd: string;
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const root =
    configDir !== undefined && configDir.length > 0 ? configDir : join(homedir(), ".claude");
  return join(root, "projects");
}

/** Null when the session was never identified, or its transcript is gone. */
export function resolveTranscriptPath(
  source: ForkSource,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const agentSessionId = source.agentSessionId;
  if (agentSessionId === undefined || agentSessionId.length === 0) return null;
  const projects = claudeProjectsDir(env);
  const file = `${agentSessionId}.jsonl`;

  const bySlug = join(projects, projectSlug(source.cwd), file);
  if (existsSync(bySlug)) return bySlug;

  let entries: string[];
  try {
    entries = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(projects, entry, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Tolerant read: a torn or non-object line is skipped, never thrown on. */
export function readTranscriptLines(path: string): unknown[] {
  const lines: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // unparseable line — not something a fork can carry forward
    }
  }
  return lines;
}

export function newAgentSessionId(): string {
  return randomUUID();
}

export function claudeVersion(file = "claude"): string | null {
  try {
    const output = execFileSync(file, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

function contentBlocks(line: TranscriptLine): Record<string, unknown>[] {
  const content = asRecord(line.message)?.content;
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record !== undefined) blocks.push(record);
  }
  return blocks;
}

function transcriptShapeProblem(lines: readonly unknown[]): string | undefined {
  let nodes = 0;
  let withSessionId = 0;
  let assistants = 0;
  for (const line of lines) {
    const record = asRecord(line);
    if (record === undefined) continue;
    if (asNonEmptyString(record.uuid) === undefined) continue;
    nodes++;
    if (!("parentUuid" in record)) return "conversation lines carry no parentUuid";
    const type = asNonEmptyString(record.type);
    if (type === undefined) return "conversation lines carry no type";
    if (asNonEmptyString(record.sessionId) !== undefined) withSessionId++;
    if (type === "assistant" && asRecord(record.message) !== undefined) assistants++;
  }
  if (nodes === 0) return "no conversation lines with a uuid";
  if (withSessionId === 0) return "conversation lines carry no sessionId";
  if (assistants === 0) return "no assistant lines with a message";
  return undefined;
}

/**
 * A refusal reason, or null when forking this transcript is supported. The
 * guard is deliberately blunt: a shape we do not recognize means a corrupted
 * fork, so it stops before writing anything.
 */
export function checkForkSupport(lines: readonly unknown[], version: string | null): string | null {
  if (version === null) {
    return "could not read the Claude Code version (`claude --version` failed); fork needs the claude CLI on PATH";
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major !== SUPPORTED_CLAUDE_MAJOR) {
    return `fork was verified against Claude Code ${SUPPORTED_CLAUDE_MAJOR}.x and found ${version}; re-verify the transcript format before forking on this version`;
  }
  const problem = transcriptShapeProblem(lines);
  if (problem !== undefined) {
    return `this transcript does not look like a Claude Code ${SUPPORTED_CLAUDE_MAJOR}.x conversation (${problem}); refusing to fork rather than write a broken session`;
  }
  return null;
}

function resolveCutPoint(
  records: readonly (TranscriptLine | undefined)[],
  at: number | string,
): number {
  if (records.length === 0) throw new Error("the transcript has no lines to fork from");
  if (typeof at === "number") {
    if (!Number.isFinite(at)) throw new Error(`invalid cut point ${String(at)}`);
    return Math.min(Math.max(Math.trunc(at), 0), records.length - 1);
  }
  const index = records.findIndex((record) => record !== undefined && record.uuid === at);
  if (index === -1) throw new Error(`the transcript has no line with uuid ${at}`);
  return index;
}

/**
 * The last index at or before `cutIndex` whose main-thread prefix leaves no
 * `tool_use` unanswered. Sidechain and metadata lines are skipped: neither can
 * be the head a resume walks back from.
 */
function headIndexOf(
  records: readonly (TranscriptLine | undefined)[],
  kept: readonly boolean[],
  cutIndex: number,
): number {
  const pending = new Set<string>();
  let head = -1;
  for (let index = 0; index <= cutIndex; index++) {
    const record = records[index];
    if (record === undefined || kept[index] !== true) continue;
    if (asNonEmptyString(record.uuid) === undefined) continue;
    if (record.isSidechain === true) continue;
    for (const block of contentBlocks(record)) {
      if (block.type === "tool_use") {
        const id = asNonEmptyString(block.id);
        if (id !== undefined) pending.add(id);
      } else if (block.type === "tool_result") {
        const id = asNonEmptyString(block.tool_use_id);
        if (id !== undefined) pending.delete(id);
      }
    }
    if (pending.size === 0) head = index;
  }
  return head;
}

function rewriteSessionId(line: TranscriptLine, newSessionId: string): TranscriptLine {
  const copy: TranscriptLine = { ...line };
  for (const field of SESSION_ID_FIELDS) {
    if (typeof copy[field] === "string") copy[field] = newSessionId;
  }
  return copy;
}

/**
 * Truncate a transcript into a prefix that Claude Code can resume. Pure: the
 * input lines are read, never mutated, and the returned lines are fresh
 * shallow copies with the session id rewritten.
 */
export function planFork(lines: readonly unknown[], cut: ForkCutPoint): ForkPlan {
  const records = lines.map((line) => asRecord(line));
  const cutIndex = resolveCutPoint(records, cut.at);

  // A line survives only if its parent did, so no kept line can point at a
  // dropped one. Metadata lines are provisionally kept and filtered below.
  const alive = new Set<string>();
  const kept: boolean[] = [];
  for (let index = 0; index <= cutIndex; index++) {
    const record = records[index];
    if (record === undefined) {
      kept[index] = false;
      continue;
    }
    const uuid = asNonEmptyString(record.uuid);
    if (uuid === undefined) {
      // No uuid at all is per-session metadata; a uuid that is not a usable
      // string is a line nothing can chain to, so it cannot be carried over.
      kept[index] = !("uuid" in record);
      continue;
    }
    const parent = record.parentUuid;
    const rooted = parent === null || parent === undefined;
    if (!rooted && (typeof parent !== "string" || !alive.has(parent))) {
      kept[index] = false;
      continue;
    }
    alive.add(uuid);
    kept[index] = true;
  }

  const headIndex = headIndexOf(records, kept, cutIndex);
  const keptUuids = new Set<string>();
  for (let index = 0; index <= headIndex; index++) {
    const record = records[index];
    if (record === undefined || kept[index] !== true) continue;
    const uuid = asNonEmptyString(record.uuid);
    if (uuid !== undefined) keptUuids.add(uuid);
  }

  const planned: TranscriptLine[] = [];
  for (let index = 0; index <= headIndex; index++) {
    const record = records[index];
    if (record === undefined || kept[index] !== true) continue;
    if (asNonEmptyString(record.uuid) === undefined) {
      const dangling = UUID_REFERENCE_FIELDS.some((field) => {
        const reference = asNonEmptyString(record[field]);
        return reference !== undefined && !keptUuids.has(reference);
      });
      if (dangling) continue;
    }
    planned.push(rewriteSessionId(record, cut.newSessionId));
  }

  const headRecord = headIndex >= 0 ? records[headIndex] : undefined;
  return {
    lines: planned,
    cutIndex,
    dropped: cutIndex + 1 - planned.length,
    headUuid: headRecord === undefined ? null : (asNonEmptyString(headRecord.uuid) ?? null),
  };
}

/**
 * uuids of every conversation line a plan carries over. The forked session
 * resumes from these, so its tailer must not record them a second time.
 */
export function plannedUuids(lines: readonly TranscriptLine[]): Set<string> {
  const uuids = new Set<string>();
  for (const line of lines) {
    const uuid = asNonEmptyString(line.uuid);
    if (uuid !== undefined) uuids.add(uuid);
  }
  return uuids;
}

/** Writes <newSessionId>.jsonl; never opens the source, never clobbers a session. */
export function writeForkedTranscript(
  lines: readonly TranscriptLine[],
  newSessionId: string,
  projectDir: string,
): string {
  const path = join(projectDir, `${newSessionId}.jsonl`);
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(path, lines.length === 0 ? "" : `${body}\n`, { flag: "wx" });
  return path;
}

function userPromptText(line: TranscriptLine): string | undefined {
  if (line.type !== "user" || line.isSidechain === true) return undefined;
  const content = asRecord(line.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of contentBlocks(line)) {
    if (block.type === "text") {
      const text = asNonEmptyString(block.text);
      if (text !== undefined) texts.push(text);
    }
  }
  return texts.length === 0 ? undefined : texts.join("");
}

function lastIndexAtOrBefore(
  records: readonly (TranscriptLine | undefined)[],
  atMs: number,
): number {
  let found = -1;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) continue;
    const timestamp = asNonEmptyString(record.timestamp);
    if (timestamp === undefined) continue;
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed) || parsed > atMs) continue;
    found = index;
  }
  return found;
}

/**
 * Map a recorded event onto the last transcript line the fork should keep.
 *
 * `assistant.text` and `usage` carry the uuid of the line they were read from
 * (older recordings carry only a requestId, which identifies the same API
 * response). A `prompt` came from a hook, not the transcript, so it is matched
 * against the user line that carries the same text and the cut lands *before*
 * it: forking at a prompt means replaying the state that prompt was answered
 * from. Every fallback errs backwards — a miss shortens the fork rather than
 * cutting past the intended point.
 */
export function cutIndexForEvent(
  lines: readonly unknown[],
  event: SessionEvent,
  startedAt: string,
): number | null {
  const records = lines.map((line) => asRecord(line));
  const atMs = Date.parse(startedAt) + event.t;

  if (event.type === "assistant.text" || event.type === "usage") {
    const uuid = event.data.transcriptUuid;
    if (uuid !== undefined) {
      const index = records.findIndex((record) => record !== undefined && record.uuid === uuid);
      if (index !== -1) return index;
    }
    const requestId = event.data.requestId;
    if (requestId !== undefined) {
      let last = -1;
      for (let index = 0; index < records.length; index++) {
        if (records[index]?.requestId === requestId) last = index;
      }
      if (last !== -1) return last;
    }
  }

  if (event.type === "prompt") {
    const wanted = event.data.text.trim();
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (record === undefined) continue;
      if (userPromptText(record)?.trim() !== wanted) continue;
      return index - 1;
    }
  }

  const byTime = lastIndexAtOrBefore(records, atMs);
  return byTime === -1 ? null : byTime;
}

export function forkPoints(events: readonly SessionEvent[]): ForkPoint[] {
  const points: ForkPoint[] = [];
  for (const event of events) {
    if (event.type === "prompt") {
      points.push({ seq: event.seq, t: event.t, kind: "prompt", preview: event.data.text });
    } else if (event.type === "assistant.text") {
      points.push({ seq: event.seq, t: event.t, kind: "assistant", preview: event.data.text });
    }
  }
  return points;
}
