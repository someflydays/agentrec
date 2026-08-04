export const SESSION_FORMAT_VERSION = 1;

export type AgentKind = "claude-code";

export interface SessionMeta {
  formatVersion: typeof SESSION_FORMAT_VERSION;
  /** Recorder-assigned session id (ULID, sortable by start time). */
  id: string;
  agent: AgentKind;
  /** argv of the wrapped process, e.g. ["claude", "--continue"]. */
  command: string[];
  cwd: string;
  /** ISO 8601. All event timestamps are milliseconds relative to this instant. */
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  title?: string;
  /** The wrapped agent's own session id (Claude Code session UUID). */
  agentSessionId?: string;
  gitBranch?: string;
  recorderVersion?: string;
  /** Set when this session was started by `agentrec fork`, naming its origin. */
  forkedFrom?: { sessionId: string; seq: number };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
}

export function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreation5mInputTokens: a.cacheCreation5mInputTokens + b.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: a.cacheCreation1hInputTokens + b.cacheCreation1hInputTokens,
  };
}

interface BaseEvent<T extends string, D> {
  /** Monotonic per-session sequence number, starting at 0. */
  seq: number;
  /** Milliseconds since `SessionMeta.startedAt`. */
  t: number;
  type: T;
  data: D;
}

/** First line of every events.jsonl — makes the file self-describing. */
export type SessionStartEvent = BaseEvent<"session.start", { meta: SessionMeta }>;
export type SessionEndEvent = BaseEvent<"session.end", { exitCode: number | null }>;
export type SessionTitleEvent = BaseEvent<"session.title", { title: string }>;

export type PromptEvent = BaseEvent<"prompt", { text: string }>;

export type ToolStartEvent = BaseEvent<
  "tool.start",
  { name: string; input: unknown; toolUseId?: string }
>;
export type ToolEndEvent = BaseEvent<
  "tool.end",
  { name: string; ok: boolean; output?: string; toolUseId?: string }
>;

/**
 * `transcriptUuid` is the `uuid` of the agent transcript line this was read
 * from, recorded when the capture path knows it so `agentrec fork` can cut the
 * conversation at exactly that line instead of guessing by timestamp.
 */
export type AssistantTextEvent = BaseEvent<
  "assistant.text",
  { text: string; model?: string; requestId?: string; transcriptUuid?: string }
>;

/** Emitted once per API request (deduplicated by requestId at capture time). */
export type UsageEvent = BaseEvent<
  "usage",
  { model: string; requestId: string; usage: TokenUsage; transcriptUuid?: string }
>;

export type FileChangeEvent = BaseEvent<
  "file.change",
  { path: string; kind: "create" | "edit"; diff?: string; toolUseId?: string }
>;

export type NotificationEvent = BaseEvent<"notification", { message: string }>;
export type TurnEndEvent = BaseEvent<"turn.end", Record<string, never>>;
export type SubagentEndEvent = BaseEvent<"subagent.end", Record<string, never>>;
export type TerminalResizeEvent = BaseEvent<"terminal.resize", { cols: number; rows: number }>;

/** A non-fatal problem inside the recorder itself, kept in-band for debuggability. */
export type RecorderErrorEvent = BaseEvent<"recorder.error", { source: string; message: string }>;

export type SessionEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SessionTitleEvent
  | PromptEvent
  | ToolStartEvent
  | ToolEndEvent
  | AssistantTextEvent
  | UsageEvent
  | FileChangeEvent
  | NotificationEvent
  | TurnEndEvent
  | SubagentEndEvent
  | TerminalResizeEvent
  | RecorderErrorEvent;

export type SessionEventType = SessionEvent["type"];

export type SessionEventData<T extends SessionEventType> = Extract<
  SessionEvent,
  { type: T }
>["data"];
