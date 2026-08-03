import { describe, expect, it } from "vitest";
import { normalizeUsage, type TranscriptObservation, TranscriptParser } from "../src/transcript.js";

type UsageObservation = Extract<TranscriptObservation, { kind: "usage" }>;
type TextObservation = Extract<TranscriptObservation, { kind: "assistant-text" }>;

const CUMULATIVE_USAGE = {
  input_tokens: 5,
  output_tokens: 617,
  cache_read_input_tokens: 26_452,
  cache_creation_input_tokens: 3_106,
  cache_creation: {
    ephemeral_5m_input_tokens: 2_106,
    ephemeral_1h_input_tokens: 1_000,
  },
};

function assistantLine(overrides: {
  requestId: string;
  content: unknown[];
  model?: string;
  usage?: unknown;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "1f4a0d3c-0000-4000-8000-000000000001",
    sessionId: "9b1c7e60-0000-4000-8000-000000000002",
    timestamp: "2026-08-01T17:03:21.412Z",
    requestId: overrides.requestId,
    ...(overrides.isSidechain !== undefined ? { isSidechain: overrides.isSidechain } : {}),
    message: {
      id: "msg_01ABC",
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: overrides.content,
      usage: overrides.usage ?? CUMULATIVE_USAGE,
    },
  });
}

function observeAll(lines: string[]): TranscriptObservation[] {
  const parser = new TranscriptParser();
  return lines.flatMap((line) => parser.observe(line));
}

function usageOnly(observations: TranscriptObservation[]): UsageObservation[] {
  return observations.filter((o): o is UsageObservation => o.kind === "usage");
}

function textOnly(observations: TranscriptObservation[]): TextObservation[] {
  return observations.filter((o): o is TextObservation => o.kind === "assistant-text");
}

describe("TranscriptParser", () => {
  it("emits one usage observation and one assistant text for a response split across content blocks", () => {
    const requestId = "req_011CQr8xVYd2ZfN3TmKpWq7A";
    const observations = observeAll([
      assistantLine({
        requestId,
        content: [
          { type: "thinking", thinking: "The watchdog uses a real timer.", signature: "sig" },
        ],
      }),
      assistantLine({
        requestId,
        content: [{ type: "text", text: "Let me read the watchdog test first." }],
      }),
      assistantLine({
        requestId,
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "Read",
            input: { file_path: "/home/dev/circuitsim/tests/watchdog.test.ts" },
          },
        ],
      }),
    ]);

    expect(usageOnly(observations)).toHaveLength(1);
    expect(textOnly(observations)).toHaveLength(1);
    expect(observations).toEqual([
      {
        kind: "usage",
        model: "claude-fable-5",
        requestId,
        usage: {
          inputTokens: 5,
          outputTokens: 617,
          cacheReadInputTokens: 26_452,
          cacheCreation5mInputTokens: 2_106,
          cacheCreation1hInputTokens: 1_000,
        },
      },
      {
        kind: "assistant-text",
        text: "Let me read the watchdog test first.",
        model: "claude-fable-5",
        requestId,
      },
    ]);
  });

  it("counts usage once per request id across separate API responses", () => {
    const observations = observeAll([
      assistantLine({ requestId: "req_a", content: [{ type: "text", text: "one" }] }),
      assistantLine({ requestId: "req_b", content: [{ type: "text", text: "two" }] }),
      assistantLine({ requestId: "req_b", content: [{ type: "text", text: "two again" }] }),
    ]);

    expect(usageOnly(observations).map((o) => o.requestId)).toEqual(["req_a", "req_b"]);
    expect(textOnly(observations)).toHaveLength(3);
  });

  it("keeps sidechain usage but suppresses sidechain text", () => {
    const observations = observeAll([
      assistantLine({
        requestId: "req_sub",
        model: "claude-opus-5",
        isSidechain: true,
        content: [{ type: "text", text: "Subagent scratch reasoning." }],
      }),
    ]);

    expect(textOnly(observations)).toEqual([]);
    expect(usageOnly(observations).map((o) => o.model)).toEqual(["claude-opus-5"]);
  });

  it("emits every text block of a multi-text response", () => {
    const observations = observeAll([
      assistantLine({
        requestId: "req_multi",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "Second paragraph." },
        ],
      }),
    ]);

    expect(textOnly(observations).map((o) => o.text)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
  });

  it("ignores empty text blocks", () => {
    const observations = observeAll([
      assistantLine({ requestId: "req_empty", content: [{ type: "text", text: "" }] }),
    ]);

    expect(textOnly(observations)).toEqual([]);
  });

  it("skips usage when the line carries no request id or no model", () => {
    const parser = new TranscriptParser();
    const noRequestId = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "claude-fable-5", usage: CUMULATIVE_USAGE, content: [] },
    });
    const noModel = JSON.stringify({
      type: "assistant",
      requestId: "req_no_model",
      message: { role: "assistant", usage: CUMULATIVE_USAGE, content: [] },
    });

    expect(parser.observe(noRequestId)).toEqual([]);
    expect(parser.observe(noModel)).toEqual([]);
  });

  it("emits a title once and suppresses an immediately repeated title", () => {
    const parser = new TranscriptParser();
    const line = JSON.stringify({
      type: "ai-title",
      aiTitle: "Fix flaky watchdog test in circuitsim",
    });

    expect(parser.observe(line)).toEqual([
      { kind: "title", title: "Fix flaky watchdog test in circuitsim" },
    ]);
    expect(parser.observe(line)).toEqual([]);
  });

  it("emits a title again when it changes", () => {
    const parser = new TranscriptParser();
    parser.observe(JSON.stringify({ type: "ai-title", aiTitle: "First guess" }));
    expect(parser.observe(JSON.stringify({ type: "ai-title", aiTitle: "Better title" }))).toEqual([
      { kind: "title", title: "Better title" },
    ]);
  });

  it("ignores blank, malformed, and unrecognized lines without throwing", () => {
    const parser = new TranscriptParser();
    const lines = [
      "",
      "   ",
      "not json",
      "{ truncated",
      '{"type":"user","message":{"role":"user","content":"hello"}}',
      '{"type":"system","subtype":"init"}',
      '{"type":"summary","summary":"earlier conversation"}',
      '{"type":"ai-title"}',
      '{"type":"assistant"}',
      '{"type":"assistant","requestId":"req_str","message":{"role":"assistant","model":"claude-fable-5","content":"plain string"}}',
      "[]",
      "42",
      '"a bare string"',
      "null",
    ];

    for (const line of lines) {
      expect(parser.observe(line), `line: ${line}`).toEqual([]);
    }
  });
});

describe("normalizeUsage", () => {
  it("maps the cache creation TTL breakdown onto the 5m and 1h tiers", () => {
    expect(
      normalizeUsage({
        input_tokens: 11,
        output_tokens: 402,
        cache_read_input_tokens: 18_204,
        cache_creation_input_tokens: 9_500,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_100,
          ephemeral_1h_input_tokens: 8_400,
        },
      }),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 402,
      cacheReadInputTokens: 18_204,
      cacheCreation5mInputTokens: 1_100,
      cacheCreation1hInputTokens: 8_400,
    });
  });

  it("falls back to the flat cache creation total as the 5m tier when no breakdown is present", () => {
    expect(
      normalizeUsage({
        input_tokens: 3,
        output_tokens: 90,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 2_048,
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 90,
      cacheReadInputTokens: 500,
      cacheCreation5mInputTokens: 2_048,
      cacheCreation1hInputTokens: 0,
    });
  });

  it("treats an empty TTL breakdown as zero rather than using the flat total", () => {
    expect(normalizeUsage({ cache_creation_input_tokens: 999, cache_creation: {} })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
    });
  });

  it("defaults every missing field to zero", () => {
    expect(normalizeUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
    });
  });
});
