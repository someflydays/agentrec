import { type SessionSummary, summarizeSession } from "./summary.js";
import type { SessionEvent, SessionMeta, TokenUsage } from "./types.js";

/**
 * Compares two recorded sessions: "I ran the same task twice — what differed?"
 *
 * Two layers, deliberately separable. A turn is a prompt plus everything until
 * the next prompt; turns pair across sessions by prompt-text similarity. Inside
 * a pair, tool calls align by name through a longest-common-subsequence pass, so
 * one extra call does not desync everything after it.
 *
 * The alignment is a heuristic: short or repetitive prompts pair badly, and
 * events before the first prompt belong to no turn. `totals` is not heuristic —
 * every count there is exact over all events on each side. Assistant prose is
 * never compared.
 */

export interface SessionInput {
  meta: SessionMeta;
  events: SessionEvent[];
}

export interface DiffOptions {
  /** Minimum prompt similarity, 0..1, for two turns to pair. */
  similarityThreshold?: number;
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

export interface ToolCall {
  seq: number;
  name: string;
  input: unknown;
  /** The argument that identifies the call for display, e.g. a Bash command. */
  detail: string | null;
  /** Null when no matching tool.end was recorded (live session, crash mid-call). */
  ok: boolean | null;
}

export interface SessionTurn {
  /** 0-based position of the turn within its own session. */
  index: number;
  prompt: string;
  /** Milliseconds from session start to the prompt that opened the turn. */
  startMs: number;
  toolCalls: ToolCall[];
  filesChanged: string[];
}

/** One step of the tool-call alignment inside a paired turn. */
export type ToolAlignment =
  | { status: "same"; a: ToolCall; b: ToolCall }
  | { status: "changed"; a: ToolCall; b: ToolCall }
  | { status: "only-a"; a: ToolCall }
  | { status: "only-b"; b: ToolCall };

export interface AlignedTurn {
  a: SessionTurn;
  b: SessionTurn;
  similarity: number;
  tools: ToolAlignment[];
}

/**
 * Tool calls by alignment status. Unpaired turns contribute their calls to
 * `onlyA`/`onlyB`, so `same + changed + onlyA` is every tool call in A and
 * `same + changed + onlyB` is every tool call in B.
 */
export interface ToolAlignmentCounts {
  same: number;
  changed: number;
  onlyA: number;
  onlyB: number;
}

/** Deltas throughout are b - a; null when either side is unknown. */
export interface NumericDiff {
  a: number;
  b: number;
  delta: number;
}

export interface NullableNumericDiff {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface SetDiff {
  onlyA: string[];
  onlyB: string[];
  both: string[];
}

export interface UsageDiff {
  a: TokenUsage;
  b: TokenUsage;
  delta: TokenUsage;
}

export interface DiffTotals {
  durationMs: NullableNumericDiff;
  prompts: NumericDiff;
  toolCalls: NumericDiff;
  /** Keyed by tool name, sorted; a name missing from one side counts zero there. */
  toolCounts: Record<string, NumericDiff>;
  failedToolCalls: NumericDiff;
  toolAlignment: ToolAlignmentCounts;
  files: SetDiff;
  commands: SetDiff;
  usage: UsageDiff;
  costUsd: NullableNumericDiff;
}

export interface SessionDiff {
  a: SessionSummary;
  b: SessionSummary;
  similarityThreshold: number;
  /** Paired turns, in A order. */
  turns: AlignedTurn[];
  onlyInA: SessionTurn[];
  onlyInB: SessionTurn[];
  totals: DiffTotals;
  /** True when nothing compared here differs. Assistant prose is not compared. */
  identical: boolean;
}

/**
 * Ordered by how well the field identifies a call: the first one present wins,
 * covering Bash, the file tools, Grep/Glob, WebFetch and Task without a
 * per-tool table.
 */
const DETAIL_FIELDS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "subagent_type",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(input: unknown, field: string): string | null {
  const value = asRecord(input)?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function detailOf(input: unknown): string | null {
  for (const field of DETAIL_FIELDS) {
    const value = stringField(input, field);
    // Collapsed so a heredoc or multi-line command stays one readable line.
    if (value !== null) return value.replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * JSON.stringify follows key insertion order, so two identical tool inputs
 * recorded with different key order would compare unequal — sort keys first.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = asRecord(value);
  if (record === null) return JSON.stringify(value) ?? "null";
  const entries = Object.entries(record).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const fields = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${fields.join(",")}}`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

/**
 * Dice coefficient over word sets: 1 when the two prompts use exactly the same
 * words, 0 when they share none. Word-level rather than character-level so that
 * rewording scores low and padding an otherwise identical prompt scores high.
 */
export function promptSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.size === 0 || wordsB.size === 0) return wordsA.size === wordsB.size ? 1 : 0;
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return (2 * shared) / (wordsA.size + wordsB.size);
}

type AlignmentOp<A, B> =
  | { kind: "match"; a: A; b: B; score: number }
  | { kind: "only-a"; a: A }
  | { kind: "only-b"; b: B };

/**
 * Order-preserving alignment — a longest-common-subsequence DP generalized from
 * "equal or not" to a score, maximizing the summed score of matched pairs.
 * `score` returns null for pairs that must not match. O(n·m) in time and space.
 * Elements are objects so that an undefined lookup means "past the end", nothing
 * else.
 */
function alignSequences<A extends object, B extends object>(
  as: readonly A[],
  bs: readonly B[],
  score: (a: A, b: B) => number | null,
): AlignmentOp<A, B>[] {
  const n = as.length;
  const m = bs.length;
  const scores: (number | null)[] = new Array(n * m).fill(null);
  for (const [i, a] of as.entries()) {
    for (const [j, b] of bs.entries()) {
      scores[i * m + j] = score(a, b);
    }
  }

  // best[i][j]: best total score aligning as[i..n) against bs[j..m).
  const width = m + 1;
  const best: number[] = new Array((n + 1) * width).fill(0);
  const at = (i: number, j: number): number => best[i * width + j] ?? 0;
  const pairAt = (i: number, j: number): number | null => scores[i * m + j] ?? null;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = pairAt(i, j);
      const matched = pair === null ? Number.NEGATIVE_INFINITY : pair + at(i + 1, j + 1);
      best[i * width + j] = Math.max(matched, at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: AlignmentOp<A, B>[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const a = as[i];
    const b = bs[j];
    if (a === undefined) {
      if (b === undefined) break;
      ops.push({ kind: "only-b", b });
      j += 1;
      continue;
    }
    if (b === undefined) {
      ops.push({ kind: "only-a", a });
      i += 1;
      continue;
    }
    const pair = pairAt(i, j);
    if (pair !== null && pair + at(i + 1, j + 1) >= at(i, j)) {
      ops.push({ kind: "match", a, b, score: pair });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "only-a", a });
      i += 1;
    } else {
      ops.push({ kind: "only-b", b });
      j += 1;
    }
  }
  return ops;
}

/**
 * tool.end carries a toolUseId by convention only; when it is absent or unknown
 * the end belongs to the most recent unfinished call of the same name.
 */
function findOpenCall(
  turn: SessionTurn | null,
  openById: Map<string, ToolCall>,
  end: { name: string; toolUseId?: string },
): ToolCall | null {
  if (end.toolUseId !== undefined) {
    const byId = openById.get(end.toolUseId);
    if (byId !== undefined) {
      openById.delete(end.toolUseId);
      return byId;
    }
  }
  if (turn === null) return null;
  for (let i = turn.toolCalls.length - 1; i >= 0; i--) {
    const call = turn.toolCalls[i];
    if (call !== undefined && call.name === end.name && call.ok === null) return call;
  }
  return null;
}

/** Split a session at its prompts. Events before the first prompt are dropped. */
export function splitTurns(events: SessionEvent[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const openById = new Map<string, ToolCall>();
  let current: SessionTurn | null = null;

  for (const event of events) {
    switch (event.type) {
      case "prompt": {
        current = {
          index: turns.length,
          prompt: event.data.text,
          startMs: event.t,
          toolCalls: [],
          filesChanged: [],
        };
        turns.push(current);
        break;
      }
      case "tool.start": {
        if (current === null) break;
        const call: ToolCall = {
          seq: event.seq,
          name: event.data.name,
          input: event.data.input,
          detail: detailOf(event.data.input),
          ok: null,
        };
        current.toolCalls.push(call);
        if (event.data.toolUseId !== undefined) openById.set(event.data.toolUseId, call);
        break;
      }
      case "tool.end": {
        const call = findOpenCall(current, openById, event.data);
        if (call !== null) call.ok = event.data.ok;
        break;
      }
      case "file.change": {
        if (current === null) break;
        if (!current.filesChanged.includes(event.data.path)) {
          current.filesChanged.push(event.data.path);
        }
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

function alignToolCalls(a: SessionTurn, b: SessionTurn): ToolAlignment[] {
  const ops = alignSequences(a.toolCalls, b.toolCalls, (x, y) => (x.name === y.name ? 1 : null));
  return ops.map((op): ToolAlignment => {
    if (op.kind === "only-a") return { status: "only-a", a: op.a };
    if (op.kind === "only-b") return { status: "only-b", b: op.b };
    if (canonicalJson(op.a.input) === canonicalJson(op.b.input)) {
      return { status: "same", a: op.a, b: op.b };
    }
    return { status: "changed", a: op.a, b: op.b };
  });
}

function countToolAlignment(
  turns: AlignedTurn[],
  onlyInA: SessionTurn[],
  onlyInB: SessionTurn[],
): ToolAlignmentCounts {
  const counts: ToolAlignmentCounts = { same: 0, changed: 0, onlyA: 0, onlyB: 0 };
  for (const turn of turns) {
    for (const entry of turn.tools) {
      if (entry.status === "same") counts.same += 1;
      else if (entry.status === "changed") counts.changed += 1;
      else if (entry.status === "only-a") counts.onlyA += 1;
      else counts.onlyB += 1;
    }
  }
  for (const turn of onlyInA) counts.onlyA += turn.toolCalls.length;
  for (const turn of onlyInB) counts.onlyB += turn.toolCalls.length;
  return counts;
}

interface SideExtras {
  failedToolCalls: number;
  commands: string[];
}

function collectExtras(events: SessionEvent[]): SideExtras {
  let failedToolCalls = 0;
  const commands = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.end" && !event.data.ok) failedToolCalls += 1;
    if (event.type === "tool.start" && event.data.name === "Bash") {
      const command = stringField(event.data.input, "command");
      if (command !== null) commands.add(command);
    }
  }
  return { failedToolCalls, commands: [...commands].sort() };
}

function numericDiff(a: number, b: number): NumericDiff {
  return { a, b, delta: b - a };
}

function nullableNumericDiff(a: number | null, b: number | null): NullableNumericDiff {
  return { a, b, delta: a === null || b === null ? null : b - a };
}

function splitSets(a: readonly string[], b: readonly string[]): SetDiff {
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    onlyA: a.filter((value) => !inB.has(value)),
    onlyB: b.filter((value) => !inA.has(value)),
    both: a.filter((value) => inB.has(value)),
  };
}

function usageDiff(a: TokenUsage, b: TokenUsage): UsageDiff {
  return {
    a,
    b,
    delta: {
      inputTokens: b.inputTokens - a.inputTokens,
      outputTokens: b.outputTokens - a.outputTokens,
      cacheReadInputTokens: b.cacheReadInputTokens - a.cacheReadInputTokens,
      cacheCreation5mInputTokens: b.cacheCreation5mInputTokens - a.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: b.cacheCreation1hInputTokens - a.cacheCreation1hInputTokens,
    },
  };
}

function diffToolCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, NumericDiff> {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const counts: Record<string, NumericDiff> = {};
  for (const name of names) counts[name] = numericDiff(a[name] ?? 0, b[name] ?? 0);
  return counts;
}

function usageIsZero(usage: TokenUsage): boolean {
  return Object.values(usage).every((value) => value === 0);
}

export function diffSessions(
  a: SessionInput,
  b: SessionInput,
  options: DiffOptions = {},
): SessionDiff {
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const ops = alignSequences(splitTurns(a.events), splitTurns(b.events), (x, y) => {
    const similarity = promptSimilarity(x.prompt, y.prompt);
    return similarity >= similarityThreshold ? similarity : null;
  });

  const turns: AlignedTurn[] = [];
  const onlyInA: SessionTurn[] = [];
  const onlyInB: SessionTurn[] = [];
  for (const op of ops) {
    if (op.kind === "only-a") onlyInA.push(op.a);
    else if (op.kind === "only-b") onlyInB.push(op.b);
    else turns.push({ a: op.a, b: op.b, similarity: op.score, tools: alignToolCalls(op.a, op.b) });
  }

  const summaryA = summarizeSession(a.meta, a.events);
  const summaryB = summarizeSession(b.meta, b.events);
  const extrasA = collectExtras(a.events);
  const extrasB = collectExtras(b.events);

  const totals: DiffTotals = {
    durationMs: nullableNumericDiff(summaryA.durationMs, summaryB.durationMs),
    prompts: numericDiff(summaryA.prompts, summaryB.prompts),
    toolCalls: numericDiff(summaryA.toolCalls, summaryB.toolCalls),
    toolCounts: diffToolCounts(summaryA.toolCounts, summaryB.toolCounts),
    failedToolCalls: numericDiff(extrasA.failedToolCalls, extrasB.failedToolCalls),
    toolAlignment: countToolAlignment(turns, onlyInA, onlyInB),
    files: splitSets(summaryA.filesChanged, summaryB.filesChanged),
    commands: splitSets(extrasA.commands, extrasB.commands),
    usage: usageDiff(summaryA.totalUsage, summaryB.totalUsage),
    costUsd: nullableNumericDiff(summaryA.totalCostUsd, summaryB.totalCostUsd),
  };

  const identical =
    onlyInA.length === 0 &&
    onlyInB.length === 0 &&
    turns.every((turn) => turn.a.prompt === turn.b.prompt) &&
    totals.toolAlignment.changed === 0 &&
    totals.toolAlignment.onlyA === 0 &&
    totals.toolAlignment.onlyB === 0 &&
    totals.prompts.delta === 0 &&
    totals.toolCalls.delta === 0 &&
    totals.failedToolCalls.delta === 0 &&
    totals.files.onlyA.length === 0 &&
    totals.files.onlyB.length === 0 &&
    totals.commands.onlyA.length === 0 &&
    totals.commands.onlyB.length === 0 &&
    usageIsZero(totals.usage.delta) &&
    totals.costUsd.a === totals.costUsd.b &&
    totals.durationMs.a === totals.durationMs.b;

  return {
    a: summaryA,
    b: summaryB,
    similarityThreshold,
    turns,
    onlyInA,
    onlyInB,
    totals,
    identical,
  };
}
