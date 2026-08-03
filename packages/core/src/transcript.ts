import { type TokenUsage, zeroUsage } from "./types.js";

/**
 * Claude Code writes a JSONL transcript per session under
 * ~/.claude/projects/<project-slug>/<session-uuid>.jsonl. The recorder tails
 * that file for the data hooks don't carry: assistant text, token usage, and
 * the AI-generated session title.
 *
 * One API response is spread across multiple "assistant" lines (one per
 * content block: thinking, text, tool_use), and every line repeats the same
 * cumulative usage object under the same requestId. Counting usage per line
 * would multiply real token spend — TranscriptParser deduplicates by
 * requestId and emits a single usage observation per API request.
 */

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface RawContentBlock {
  type?: string;
  text?: string;
}

interface RawTranscriptLine {
  type?: string;
  requestId?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: RawUsage;
    content?: RawContentBlock[] | string;
  };
}

export type TranscriptObservation =
  | { kind: "assistant-text"; text: string; model?: string; requestId?: string }
  | { kind: "usage"; model: string; requestId: string; usage: TokenUsage }
  | { kind: "title"; title: string };

export function normalizeUsage(raw: RawUsage): TokenUsage {
  const usage = zeroUsage();
  usage.inputTokens = raw.input_tokens ?? 0;
  usage.outputTokens = raw.output_tokens ?? 0;
  usage.cacheReadInputTokens = raw.cache_read_input_tokens ?? 0;
  const breakdown = raw.cache_creation;
  if (breakdown) {
    usage.cacheCreation5mInputTokens = breakdown.ephemeral_5m_input_tokens ?? 0;
    usage.cacheCreation1hInputTokens = breakdown.ephemeral_1h_input_tokens ?? 0;
  } else {
    // No TTL breakdown — attribute everything to the cheaper 5m tier.
    usage.cacheCreation5mInputTokens = raw.cache_creation_input_tokens ?? 0;
  }
  return usage;
}

export class TranscriptParser {
  private readonly seenUsageRequestIds = new Set<string>();
  private lastTitle: string | undefined;

  /** Feed one transcript line; returns zero or more normalized observations. */
  observe(line: string): TranscriptObservation[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];

    let raw: RawTranscriptLine;
    try {
      raw = JSON.parse(trimmed) as RawTranscriptLine;
    } catch {
      return [];
    }

    if (raw.type === "ai-title" && typeof raw.aiTitle === "string") {
      if (raw.aiTitle === this.lastTitle) return [];
      this.lastTitle = raw.aiTitle;
      return [{ kind: "title", title: raw.aiTitle }];
    }

    if (raw.type !== "assistant" || raw.message === undefined) return [];

    const observations: TranscriptObservation[] = [];
    const { message, requestId } = raw;

    // Sidechain (subagent) text would interleave confusingly with the main
    // thread, but its token spend is real — keep usage, drop the text.
    if (raw.isSidechain !== true && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          observations.push({
            kind: "assistant-text",
            text: block.text,
            ...(message.model !== undefined ? { model: message.model } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          });
        }
      }
    }

    if (
      message.usage !== undefined &&
      typeof requestId === "string" &&
      typeof message.model === "string" &&
      !this.seenUsageRequestIds.has(requestId)
    ) {
      this.seenUsageRequestIds.add(requestId);
      observations.push({
        kind: "usage",
        model: message.model,
        requestId,
        usage: normalizeUsage(message.usage),
      });
    }

    return observations;
  }
}
