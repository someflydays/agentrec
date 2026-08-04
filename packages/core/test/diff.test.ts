import { describe, expect, it } from "vitest";
import {
  type AlignedTurn,
  DEFAULT_SIMILARITY_THRESHOLD,
  diffSessions,
  promptSimilarity,
  type SessionDiff,
  type SessionInput,
  splitTurns,
} from "../src/diff.js";
import { estimateCostUsd } from "../src/pricing.js";
import type {
  SessionEvent,
  SessionEventData,
  SessionEventType,
  SessionMeta,
  TokenUsage,
} from "../src/types.js";
import { makeEvent } from "./helpers.js";

const ID_A = "01DIFFAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01DIFFBBBBBBBBBBBBBBBBBBBB";
const STARTED_AT = "2026-08-01T17:03:12.000Z";
const ENDED_AT = "2026-08-01T17:12:27.000Z";

type Step =
  | { prompt: string }
  | { tool: string; input?: unknown; ok?: boolean }
  | { file: string }
  | { model: string; usage: TokenUsage };

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

function session(id: string, steps: Step[], overrides: Partial<SessionMeta> = {}): SessionInput {
  const meta: SessionMeta = {
    formatVersion: 1,
    id,
    agent: "claude-code",
    command: ["claude"],
    cwd: "/repo",
    startedAt: STARTED_AT,
    ...overrides,
  };
  const events: SessionEvent[] = [makeEvent(0, 0, "session.start", { meta })];
  function push<T extends SessionEventType>(type: T, data: SessionEventData<T>): void {
    events.push(makeEvent(events.length, events.length * 1_000, type, data));
  }
  for (const step of steps) {
    if ("prompt" in step) {
      push("prompt", { text: step.prompt });
    } else if ("tool" in step) {
      push("tool.start", { name: step.tool, input: step.input ?? {} });
      push("tool.end", { name: step.tool, ok: step.ok ?? true });
    } else if ("file" in step) {
      push("file.change", { path: step.file, kind: "edit" });
    } else {
      push("usage", { model: step.model, requestId: `req_${events.length}`, usage: step.usage });
    }
  }
  return { meta, events };
}

const FLAKY_PROMPT = "fix the flaky watchdog test on CI";
const FABLE_USAGE = usage({
  inputTokens: 40,
  outputTokens: 900,
  cacheReadInputTokens: 12_000,
  cacheCreation5mInputTokens: 3_000,
});

function baseline(): Step[] {
  return [
    { prompt: FLAKY_PROMPT },
    { tool: "Read", input: { file_path: "tests/watchdog.test.ts" } },
    { tool: "Bash", input: { command: "pnpm test" }, ok: false },
    { tool: "Edit", input: { file_path: "src/watchdog.ts" } },
    { file: "/repo/src/watchdog.ts" },
    { tool: "Bash", input: { command: "pnpm test" } },
    { model: "claude-fable-5", usage: FABLE_USAGE },
  ];
}

function alignedTurn(diff: SessionDiff, index: number): AlignedTurn {
  const turn = diff.turns[index];
  if (turn === undefined) {
    throw new Error(`no aligned turn at ${index} (paired ${diff.turns.length})`);
  }
  return turn;
}

function statuses(diff: SessionDiff, index = 0): string[] {
  return alignedTurn(diff, index).tools.map((entry) => entry.status);
}

describe("promptSimilarity", () => {
  it("scores rewordings of one ask above unrelated asks", () => {
    const reworded = promptSimilarity(
      FLAKY_PROMPT,
      "please fix the flaky watchdog test that fails on CI",
    );
    const unrelated = promptSimilarity(FLAKY_PROMPT, "add a changelog entry for the release");

    expect(reworded).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(unrelated).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
  });

  it("scores identical text 1 and disjoint text 0, ignoring case and punctuation", () => {
    expect(promptSimilarity("Fix the test!", "fix   the test")).toBe(1);
    expect(promptSimilarity("alpha beta", "gamma delta")).toBe(0);
    expect(promptSimilarity("", "")).toBe(1);
    expect(promptSimilarity("", "something")).toBe(0);
  });
});

describe("splitTurns", () => {
  it("opens a turn at each prompt and drops events recorded before the first", () => {
    const input = session(ID_A, [
      { tool: "Read", input: { file_path: "warmup.ts" } },
      { prompt: "first ask" },
      { tool: "Bash", input: { command: "ls" } },
      { prompt: "second ask" },
    ]);
    const turns = splitTurns(input.events);

    expect(turns.map((turn) => turn.prompt)).toEqual(["first ask", "second ask"]);
    expect(turns[0]?.toolCalls.map((call) => call.name)).toEqual(["Bash"]);
    expect(turns[1]?.toolCalls).toEqual([]);
  });

  it("records the salient input argument and the outcome of each call", () => {
    const input = session(ID_A, [
      { prompt: "go" },
      { tool: "Bash", input: { command: "pnpm test\n  --watch" }, ok: false },
    ]);
    const call = splitTurns(input.events)[0]?.toolCalls[0];

    expect(call?.detail).toBe("pnpm test --watch");
    expect(call?.ok).toBe(false);
  });
});

describe("diffSessions", () => {
  it("reports no differences between two runs of the same script", () => {
    const diff = diffSessions(session(ID_A, baseline()), session(ID_B, baseline()));

    expect(diff.identical).toBe(true);
    expect(diff.similarityThreshold).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(statuses(diff)).toEqual(["same", "same", "same", "same"]);
    expect(diff.totals.toolAlignment).toEqual({ same: 4, changed: 0, onlyA: 0, onlyB: 0 });
    expect(diff.totals.files).toEqual({
      onlyA: [],
      onlyB: [],
      both: ["/repo/src/watchdog.ts"],
    });
    expect(diff.totals.commands).toEqual({ onlyA: [], onlyB: [], both: ["pnpm test"] });
    expect(diff.totals.prompts.delta).toBe(0);
    expect(diff.totals.toolCalls.delta).toBe(0);
    expect(diff.totals.failedToolCalls).toEqual({ a: 1, b: 1, delta: 0 });
    expect(diff.totals.usage.delta).toEqual(usage());
    expect(diff.totals.costUsd.delta).toBe(0);
  });

  it("is a no-op when a session is diffed against itself", () => {
    const only = session(ID_A, baseline());
    const diff = diffSessions(only, only);

    expect(diff.identical).toBe(true);
    expect(diff.turns).toHaveLength(1);
    expect(alignedTurn(diff, 0).similarity).toBe(1);
    expect(diff.totals.toolAlignment).toEqual({ same: 4, changed: 0, onlyA: 0, onlyB: 0 });
    expect(diff.totals.durationMs.delta).toBeNull();
  });

  it("keeps the tail aligned when B inserts a tool call in the middle", () => {
    const extended = baseline();
    extended.splice(4, 0, { tool: "Grep", input: { pattern: "setTimeout" } });
    const diff = diffSessions(session(ID_A, baseline()), session(ID_B, extended));

    expect(statuses(diff)).toEqual(["same", "same", "same", "only-b", "same"]);
    expect(diff.totals.toolAlignment).toEqual({ same: 4, changed: 0, onlyA: 0, onlyB: 1 });
    expect(diff.totals.toolCounts.Grep).toEqual({ a: 0, b: 1, delta: 1 });
    expect(diff.totals.toolCalls).toEqual({ a: 4, b: 5, delta: 1 });
    expect(diff.identical).toBe(false);
  });

  it("keeps the tail aligned when B drops a tool call in the middle", () => {
    const shortened = baseline();
    shortened.splice(2, 1);
    const diff = diffSessions(session(ID_A, baseline()), session(ID_B, shortened));

    expect(statuses(diff)).toEqual(["same", "only-a", "same", "same"]);
    expect(diff.totals.toolAlignment).toEqual({ same: 3, changed: 0, onlyA: 1, onlyB: 0 });
  });

  it("flags a rerun with different arguments as changed, not as an add plus a remove", () => {
    const retried = baseline();
    retried[5] = { tool: "Bash", input: { command: "pnpm test -- --repeat 20" } };
    const diff = diffSessions(session(ID_A, baseline()), session(ID_B, retried));

    expect(statuses(diff)).toEqual(["same", "same", "same", "changed"]);
    expect(diff.totals.toolAlignment).toEqual({ same: 3, changed: 1, onlyA: 0, onlyB: 0 });
    expect(diff.totals.commands).toEqual({
      onlyA: [],
      onlyB: ["pnpm test -- --repeat 20"],
      both: ["pnpm test"],
    });
  });

  it("ignores tool input key order when deciding whether a call changed", () => {
    const reordered = diffSessions(
      session(ID_A, [{ prompt: "go" }, { tool: "Edit", input: { file_path: "a.ts", old: "x" } }]),
      session(ID_B, [{ prompt: "go" }, { tool: "Edit", input: { old: "x", file_path: "a.ts" } }]),
    );

    expect(statuses(reordered)).toEqual(["same"]);
  });

  it("pairs reworded prompts and leaves unrelated prompts unpaired", () => {
    const diff = diffSessions(
      session(ID_A, [{ prompt: FLAKY_PROMPT }, { tool: "Read", input: { file_path: "a.ts" } }]),
      session(ID_B, [
        { prompt: "please fix the flaky watchdog test that fails on CI" },
        { tool: "Read", input: { file_path: "a.ts" } },
        { prompt: "add a changelog entry for the release" },
        { tool: "Write", input: { file_path: "CHANGELOG.md" } },
      ]),
    );

    expect(diff.turns).toHaveLength(1);
    expect(alignedTurn(diff, 0).similarity).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(statuses(diff)).toEqual(["same"]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB.map((turn) => turn.index)).toEqual([1]);
  });

  it("counts tool calls from unpaired turns as only-A or only-B", () => {
    const diff = diffSessions(
      session(ID_A, [{ prompt: "alpha beta gamma" }, { tool: "Read", input: { file_path: "a" } }]),
      session(ID_B, [{ prompt: "delta epsilon zeta" }, { tool: "Grep", input: { pattern: "x" } }]),
    );

    expect(diff.turns).toEqual([]);
    expect(diff.onlyInA).toHaveLength(1);
    expect(diff.onlyInB).toHaveLength(1);
    expect(diff.totals.toolAlignment).toEqual({ same: 0, changed: 0, onlyA: 1, onlyB: 1 });
    expect(diff.totals.toolCalls).toEqual({ a: 1, b: 1, delta: 0 });
  });

  it("honours a raised similarity threshold by refusing a loose pairing", () => {
    const a = session(ID_A, [{ prompt: FLAKY_PROMPT }]);
    const b = session(ID_B, [{ prompt: "please fix the flaky watchdog test that fails on CI" }]);

    expect(diffSessions(a, b).turns).toHaveLength(1);
    expect(diffSessions(a, b, { similarityThreshold: 0.95 }).turns).toEqual([]);
  });

  it("splits changed files three ways", () => {
    const diff = diffSessions(
      session(ID_A, [
        { prompt: "go" },
        { file: "/repo/src/shared.ts" },
        { file: "/repo/src/only-a.ts" },
      ]),
      session(ID_B, [
        { prompt: "go" },
        { file: "/repo/src/shared.ts" },
        { file: "/repo/src/only-b.ts" },
      ]),
    );

    expect(diff.totals.files).toEqual({
      onlyA: ["/repo/src/only-a.ts"],
      onlyB: ["/repo/src/only-b.ts"],
      both: ["/repo/src/shared.ts"],
    });
    expect(diff.identical).toBe(false);
  });

  it("compares token usage, cost and duration per side", () => {
    const opusUsage = usage({ inputTokens: 100, outputTokens: 200 });
    const diff = diffSessions(
      session(ID_A, [{ prompt: "go" }, { model: "claude-fable-5", usage: FABLE_USAGE }], {
        endedAt: ENDED_AT,
      }),
      session(ID_B, [{ prompt: "go" }, { model: "claude-opus-5", usage: opusUsage }], {
        endedAt: "2026-08-01T17:08:12.000Z",
      }),
    );

    expect(diff.totals.usage.a).toEqual(FABLE_USAGE);
    expect(diff.totals.usage.b).toEqual(opusUsage);
    expect(diff.totals.usage.delta).toEqual(
      usage({
        inputTokens: 60,
        outputTokens: -700,
        cacheReadInputTokens: -12_000,
        cacheCreation5mInputTokens: -3_000,
      }),
    );
    expect(diff.totals.costUsd.a).toBeCloseTo(
      estimateCostUsd("claude-fable-5", FABLE_USAGE) ?? 0,
      12,
    );
    expect(diff.totals.costUsd.b).toBeCloseTo(estimateCostUsd("claude-opus-5", opusUsage) ?? 0, 12);
    expect(diff.totals.costUsd.delta).toBeCloseTo(
      (diff.totals.costUsd.b ?? 0) - (diff.totals.costUsd.a ?? 0),
      12,
    );
    expect(diff.totals.durationMs).toEqual({ a: 555_000, b: 300_000, delta: -255_000 });
  });

  it("leaves cost null and the delta unknown when a model has no pricing", () => {
    const diff = diffSessions(
      session(ID_A, [{ prompt: "go" }, { model: "claude-fable-5", usage: FABLE_USAGE }], {
        endedAt: ENDED_AT,
      }),
      session(ID_B, [{ prompt: "go" }, { model: "claude-mystery-9", usage: FABLE_USAGE }], {
        endedAt: ENDED_AT,
      }),
    );

    expect(diff.totals.costUsd.a).toBeGreaterThan(0);
    expect(diff.totals.costUsd.b).toBeNull();
    expect(diff.totals.costUsd.delta).toBeNull();
    expect(diff.totals.usage.delta).toEqual(usage());
    expect(diff.identical).toBe(false);
  });

  it("diffs a live session against a finished one without throwing", () => {
    const diff = diffSessions(
      session(ID_A, baseline(), { endedAt: ENDED_AT }),
      session(ID_B, baseline()),
    );

    expect(diff.totals.durationMs).toEqual({ a: 555_000, b: null, delta: null });
    expect(diff.identical).toBe(false);
    expect(statuses(diff)).toEqual(["same", "same", "same", "same"]);
  });

  it("leaves a tool call open when its end was never recorded", () => {
    const live: SessionInput = session(ID_A, [{ prompt: "go" }]);
    live.events.push(
      makeEvent(live.events.length, 9_000, "tool.start", {
        name: "Bash",
        input: { command: "ls" },
      }),
    );
    const diff = diffSessions(live, session(ID_B, [{ prompt: "go" }, { tool: "Bash" }]));

    expect(alignedTurn(diff, 0).tools[0]).toMatchObject({ status: "changed" });
    expect(splitTurns(live.events)[0]?.toolCalls[0]?.ok).toBeNull();
    expect(diff.totals.failedToolCalls).toEqual({ a: 0, b: 0, delta: 0 });
  });

  it("diffs two empty sessions cleanly", () => {
    const empty = (id: string): SessionInput => ({
      meta: session(id, []).meta,
      events: [],
    });
    const diff = diffSessions(empty(ID_A), empty(ID_B));

    expect(diff.identical).toBe(true);
    expect(diff.turns).toEqual([]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(diff.totals.toolAlignment).toEqual({ same: 0, changed: 0, onlyA: 0, onlyB: 0 });
    expect(diff.totals.prompts).toEqual({ a: 0, b: 0, delta: 0 });
    expect(diff.totals.toolCounts).toEqual({});
    expect(diff.totals.files).toEqual({ onlyA: [], onlyB: [], both: [] });
    expect(diff.totals.costUsd).toEqual({ a: null, b: null, delta: null });
  });

  it("reports every turn as only-A when B recorded nothing", () => {
    const diff = diffSessions(session(ID_A, baseline()), {
      meta: session(ID_B, []).meta,
      events: [],
    });

    expect(diff.turns).toEqual([]);
    expect(diff.onlyInA).toHaveLength(1);
    expect(diff.totals.toolAlignment).toEqual({ same: 0, changed: 0, onlyA: 4, onlyB: 0 });
    expect(diff.totals.files.onlyA).toEqual(["/repo/src/watchdog.ts"]);
    expect(diff.identical).toBe(false);
  });
});
