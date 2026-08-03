import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/pricing.js";
import { type ModelUsage, summarizeSession } from "../src/summary.js";
import type { SessionEvent, SessionMeta, TokenUsage } from "../src/types.js";
import { makeEvent } from "./helpers.js";

const ID = "01SUMMARYAAAAAAAAAAAAAAAAA";
const STARTED_AT = "2026-08-01T17:03:12.000Z";
const ENDED_AT = "2026-08-01T17:12:27.000Z";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    formatVersion: 1,
    id: ID,
    agent: "claude-code",
    command: ["claude"],
    cwd: "/home/dev/circuitsim",
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    ...overrides,
  };
}

function modelFor(models: ModelUsage[], name: string): ModelUsage {
  const found = models.find((entry) => entry.model === name);
  if (found === undefined) {
    throw new Error(`no usage recorded for model ${name}`);
  }
  return found;
}

const FABLE_A = usage({
  inputTokens: 10,
  outputTokens: 300,
  cacheReadInputTokens: 20_000,
  cacheCreation5mInputTokens: 4_000,
  cacheCreation1hInputTokens: 1_000,
});
const FABLE_B = usage({
  inputTokens: 6,
  outputTokens: 120,
  cacheReadInputTokens: 24_000,
  cacheCreation5mInputTokens: 800,
});
const OPUS_A = usage({
  inputTokens: 12,
  outputTokens: 700,
  cacheReadInputTokens: 0,
  cacheCreation5mInputTokens: 14_000,
});

function storyEvents(): SessionEvent[] {
  return [
    makeEvent(0, 0, "session.start", { meta: meta() }),
    makeEvent(1, 500, "terminal.resize", { cols: 120, rows: 32 }),
    makeEvent(2, 1_000, "prompt", { text: "first ask" }),
    makeEvent(3, 1_500, "usage", {
      model: "claude-fable-5",
      requestId: "req_01",
      usage: FABLE_A,
    }),
    makeEvent(4, 2_000, "assistant.text", { text: "planning", model: "claude-fable-5" }),
    makeEvent(5, 2_500, "tool.start", { name: "Read", input: { file_path: "a.ts" } }),
    makeEvent(6, 3_000, "tool.end", { name: "Read", ok: true }),
    makeEvent(7, 3_500, "tool.start", { name: "Read", input: { file_path: "b.ts" } }),
    makeEvent(8, 4_000, "tool.end", { name: "Read", ok: true }),
    makeEvent(9, 4_500, "tool.start", { name: "Bash", input: { command: "pnpm test" } }),
    makeEvent(10, 9_000, "tool.end", { name: "Bash", ok: false, output: "1 failing" }),
    makeEvent(11, 9_500, "tool.start", { name: "Task", input: { subagent_type: "explore" } }),
    makeEvent(12, 10_000, "usage", { model: "claude-opus-5", requestId: "req_02", usage: OPUS_A }),
    makeEvent(13, 11_000, "subagent.end", {}),
    makeEvent(14, 11_500, "tool.end", { name: "Task", ok: true }),
    makeEvent(15, 12_000, "tool.start", { name: "Edit", input: { file_path: "src/b.ts" } }),
    makeEvent(16, 12_200, "file.change", { path: "/home/dev/circuitsim/src/b.ts", kind: "edit" }),
    makeEvent(17, 12_400, "tool.end", { name: "Edit", ok: true }),
    makeEvent(18, 13_000, "tool.start", { name: "Edit", input: { file_path: "src/a.ts" } }),
    makeEvent(19, 13_200, "file.change", { path: "/home/dev/circuitsim/src/a.ts", kind: "edit" }),
    makeEvent(20, 13_400, "tool.end", { name: "Edit", ok: true }),
    makeEvent(21, 14_000, "prompt", { text: "second ask" }),
    makeEvent(22, 14_500, "tool.start", { name: "Edit", input: { file_path: "src/b.ts" } }),
    makeEvent(23, 14_700, "file.change", { path: "/home/dev/circuitsim/src/b.ts", kind: "edit" }),
    makeEvent(24, 14_900, "tool.end", { name: "Edit", ok: true }),
    makeEvent(25, 15_500, "usage", {
      model: "claude-fable-5",
      requestId: "req_03",
      usage: FABLE_B,
    }),
    makeEvent(26, 16_000, "prompt", { text: "third ask" }),
    makeEvent(27, 16_500, "notification", { message: "waiting for input" }),
    makeEvent(28, 17_000, "recorder.error", { source: "transcript", message: "tail restarted" }),
    makeEvent(29, 17_500, "session.title", { title: "Fix the flaky watchdog test" }),
    makeEvent(30, 18_000, "turn.end", {}),
  ];
}

describe("summarizeSession", () => {
  it("counts prompts and tool calls per tool name", () => {
    const summary = summarizeSession(meta(), storyEvents());

    expect(summary.prompts).toBe(3);
    expect(summary.toolCalls).toBe(7);
    expect(summary.toolCounts).toEqual({ Read: 2, Bash: 1, Task: 1, Edit: 3 });
  });

  it("deduplicates changed file paths and sorts them", () => {
    const summary = summarizeSession(meta(), storyEvents());

    expect(summary.filesChanged).toEqual([
      "/home/dev/circuitsim/src/a.ts",
      "/home/dev/circuitsim/src/b.ts",
    ]);
  });

  it("aggregates usage per model and totals it across models", () => {
    const summary = summarizeSession(meta(), storyEvents());

    const fable = modelFor(summary.models, "claude-fable-5");
    expect(fable.requests).toBe(2);
    expect(fable.usage).toEqual(
      usage({
        inputTokens: 16,
        outputTokens: 420,
        cacheReadInputTokens: 44_000,
        cacheCreation5mInputTokens: 4_800,
        cacheCreation1hInputTokens: 1_000,
      }),
    );

    const opus = modelFor(summary.models, "claude-opus-5");
    expect(opus.requests).toBe(1);
    expect(opus.usage).toEqual(OPUS_A);

    expect(summary.totalUsage).toEqual(
      usage({
        inputTokens: 28,
        outputTokens: 1_120,
        cacheReadInputTokens: 44_000,
        cacheCreation5mInputTokens: 18_800,
        cacheCreation1hInputTokens: 1_000,
      }),
    );
  });

  it("prices each model and sums the per-model costs", () => {
    const summary = summarizeSession(meta(), storyEvents());

    const fable = modelFor(summary.models, "claude-fable-5");
    const opus = modelFor(summary.models, "claude-opus-5");
    expect(fable.costUsd).toBeCloseTo(estimateCostUsd("claude-fable-5", fable.usage) ?? 0, 12);
    expect(opus.costUsd).toBeCloseTo(estimateCostUsd("claude-opus-5", opus.usage) ?? 0, 12);
    expect(summary.totalCostUsd).toBeCloseTo((fable.costUsd ?? 0) + (opus.costUsd ?? 0), 12);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
  });

  it("lets a session.title event override the recorded meta title", () => {
    const summary = summarizeSession(meta({ title: "Untitled session" }), storyEvents());
    expect(summary.title).toBe("Fix the flaky watchdog test");
  });

  it("keeps the meta title when no session.title event was recorded", () => {
    const events = storyEvents().filter((event) => event.type !== "session.title");
    expect(summarizeSession(meta({ title: "From meta" }), events).title).toBe("From meta");
  });

  it("omits the title entirely when neither source supplies one", () => {
    const events = storyEvents().filter((event) => event.type !== "session.title");
    expect(summarizeSession(meta(), events)).not.toHaveProperty("title");
  });

  it("reports a null total cost when any contributing model has unknown pricing", () => {
    const events = [
      ...storyEvents(),
      makeEvent(31, 19_000, "usage", {
        model: "claude-mystery-9",
        requestId: "req_04",
        usage: usage({ outputTokens: 50 }),
      }),
    ];
    const summary = summarizeSession(meta(), events);

    expect(modelFor(summary.models, "claude-mystery-9").costUsd).toBeNull();
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.totalUsage.outputTokens).toBe(1_170);
  });

  it("reports a null total cost when the session made no API requests", () => {
    const summary = summarizeSession(meta(), [makeEvent(0, 0, "session.start", { meta: meta() })]);

    expect(summary.models).toEqual([]);
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.prompts).toBe(0);
    expect(summary.toolCalls).toBe(0);
    expect(summary.filesChanged).toEqual([]);
  });

  it("leaves duration null while the session is still live", () => {
    const summary = summarizeSession(meta(), storyEvents());

    expect(summary.durationMs).toBeNull();
    expect(summary).not.toHaveProperty("endedAt");
    expect(summary).not.toHaveProperty("exitCode");
  });

  it("computes duration from startedAt and endedAt once the session has ended", () => {
    const summary = summarizeSession(meta({ endedAt: ENDED_AT, exitCode: 0 }), storyEvents());

    expect(summary.durationMs).toBe(555_000);
    expect(summary.endedAt).toBe(ENDED_AT);
    expect(summary.exitCode).toBe(0);
  });

  it("carries identity fields through from meta", () => {
    const summary = summarizeSession(meta(), storyEvents());

    expect(summary.id).toBe(ID);
    expect(summary.agent).toBe("claude-code");
    expect(summary.startedAt).toBe(STARTED_AT);
  });
});
