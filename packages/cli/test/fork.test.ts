import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionEventData, SessionEventType } from "@agentrec/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkForkSupport,
  cutIndexForEvent,
  type ForkPlan,
  forkPoints,
  planFork,
  projectSlug,
  readTranscriptLines,
  resolveTranscriptPath,
  type TranscriptLine,
  writeForkedTranscript,
} from "../src/recorder/fork.js";

const OLD_SESSION = "11111111-1111-4111-8111-111111111111";
const NEW_SESSION = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-08-01T12:00:00.000Z");

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentrec-fork-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

let clock = 0;

function stamp(): string {
  clock += 1000;
  return new Date(START + clock).toISOString();
}

function node(
  uuid: string,
  parentUuid: string | null,
  type: string,
  extra: Record<string, unknown> = {},
): TranscriptLine {
  return {
    uuid,
    parentUuid,
    type,
    isSidechain: false,
    sessionId: OLD_SESSION,
    timestamp: stamp(),
    ...extra,
  };
}

function userText(uuid: string, parentUuid: string | null, text: string): TranscriptLine {
  return node(uuid, parentUuid, "user", { message: { role: "user", content: text } });
}

function assistantText(uuid: string, parentUuid: string, text: string, extra = {}): TranscriptLine {
  return node(uuid, parentUuid, "assistant", {
    message: { role: "assistant", model: "claude-fable-5", content: [{ type: "text", text }] },
    ...extra,
  });
}

/**
 * Claude Code writes one transcript line per content block, so a `tool_use`
 * never shares a line with the text that preceded it — see the real payloads in
 * test/fixtures/hook-payloads and the transcript they were captured beside.
 */
function assistantToolUse(uuid: string, parentUuid: string, toolUseId: string): TranscriptLine {
  return node(uuid, parentUuid, "assistant", {
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }],
    },
  });
}

function toolResult(uuid: string, parentUuid: string, toolUseId: string): TranscriptLine {
  return node(uuid, parentUuid, "user", {
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
  });
}

/**
 * 0 u1 prompt · 1 a1 text · 2 a2 tool_use · 3 u2 tool_result · 4 a3 text
 * 5 last-prompt(a3) · 6 u3 prompt · 7 a4 tool_use · 8 u4 tool_result · 9 a5 text
 */
function conversation(): TranscriptLine[] {
  clock = 0;
  return [
    userText("u1", null, "first prompt"),
    assistantText("a1", "u1", "thinking out loud", { requestId: "req_1" }),
    assistantToolUse("a2", "a1", "toolu_1"),
    toolResult("u2", "a2", "toolu_1"),
    assistantText("a3", "u2", "done with the first turn", { requestId: "req_2" }),
    { type: "last-prompt", lastPrompt: "first prompt", leafUuid: "a3", sessionId: OLD_SESSION },
    userText("u3", "a3", "second prompt"),
    assistantToolUse("a4", "u3", "toolu_2"),
    toolResult("u4", "a4", "toolu_2"),
    assistantText("a5", "u4", "done with the second turn", { requestId: "req_3" }),
  ];
}

function uuids(plan: ForkPlan): (string | undefined)[] {
  return plan.lines.map((line) => line.uuid as string | undefined);
}

function makeEvent<T extends SessionEventType>(
  seq: number,
  t: number,
  type: T,
  data: SessionEventData<T>,
): SessionEvent {
  return { seq, t, type, data } as SessionEvent;
}

describe("planFork", () => {
  it("keeps a valid prefix when cutting mid-conversation", () => {
    const lines = conversation();
    const plan = planFork(lines, { at: 4, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual(["u1", "a1", "a2", "u2", "a3"]);
    expect(plan.headUuid).toBe("a3");
    expect(plan.cutIndex).toBe(4);
    expect(plan.dropped).toBe(0);
  });

  it("leaves no kept line pointing at a dropped parent", () => {
    const lines = conversation();
    const plan = planFork(lines, { at: 8, newSessionId: NEW_SESSION });
    const kept = new Set(plan.lines.map((line) => line.uuid));

    for (const line of plan.lines) {
      if (typeof line.parentUuid === "string") expect(kept.has(line.parentUuid)).toBe(true);
    }
  });

  it("drops a trailing turn whose tool_use was never answered", () => {
    const plan = planFork(conversation(), { at: 7, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual(["u1", "a1", "a2", "u2", "a3", undefined, "u3"]);
    expect(plan.headUuid).toBe("u3");
    expect(plan.dropped).toBe(1);
  });

  it("rewrites the session id on every kept line", () => {
    const lines = conversation();
    lines[1] = { ...(lines[1] as TranscriptLine), session_id: OLD_SESSION };
    const plan = planFork(lines, { at: 9, newSessionId: NEW_SESSION });

    for (const line of plan.lines) {
      if ("sessionId" in line) expect(line.sessionId).toBe(NEW_SESSION);
      if ("session_id" in line) expect(line.session_id).toBe(NEW_SESSION);
    }
    expect(plan.lines.some((line) => line.session_id === NEW_SESSION)).toBe(true);
  });

  it("cuts at the very first line", () => {
    const plan = planFork(conversation(), { at: 0, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual(["u1"]);
    expect(plan.headUuid).toBe("u1");
  });

  it("cuts at the last line", () => {
    const lines = conversation();
    const plan = planFork(lines, { at: lines.length - 1, newSessionId: NEW_SESSION });

    expect(plan.lines).toHaveLength(lines.length);
    expect(plan.headUuid).toBe("a5");
  });

  it("clamps an out-of-range index and resolves a uuid cut point", () => {
    const lines = conversation();
    expect(planFork(lines, { at: 999, newSessionId: NEW_SESSION }).headUuid).toBe("a5");
    expect(planFork(lines, { at: "a3", newSessionId: NEW_SESSION }).headUuid).toBe("a3");
    expect(() => planFork(lines, { at: "nope", newSessionId: NEW_SESSION })).toThrow(/uuid nope/);
    expect(() => planFork([], { at: 0, newSessionId: NEW_SESSION })).toThrow(/no lines/);
  });

  it("keeps sidechain lines but never lets one become the head", () => {
    const lines = conversation();
    lines.splice(
      5,
      0,
      node("s1", "a3", "assistant", {
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent" }] },
      }),
    );
    const kept = planFork(lines, { at: 7, newSessionId: NEW_SESSION });
    expect(uuids(kept)).toEqual(["u1", "a1", "a2", "u2", "a3", "s1", undefined, "u3"]);
    expect(kept.headUuid).toBe("u3");

    const cutOnSidechain = planFork(lines, { at: 5, newSessionId: NEW_SESSION });
    expect(cutOnSidechain.headUuid).toBe("a3");
    expect(uuids(cutOnSidechain)).not.toContain("s1");
  });

  it("drops lines orphaned by the cut and metadata pointing at dropped lines", () => {
    const lines: unknown[] = [
      userText("u1", null, "first prompt"),
      node("orphan", "missing-parent", "assistant", {
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      }),
      { type: "last-prompt", lastPrompt: "gone", leafUuid: "orphan", sessionId: OLD_SESSION },
    ];
    const plan = planFork(lines, { at: 2, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual(["u1"]);
    expect(plan.dropped).toBe(2);
  });

  it("skips malformed lines instead of crashing", () => {
    const lines: unknown[] = [
      null,
      42,
      "not json",
      [],
      { type: "mode", mode: "normal" },
      userText("u1", null, "hello"),
      { uuid: 7, parentUuid: null, type: "user" },
      assistantText("a1", "u1", "hi"),
    ];
    const plan = planFork(lines, { at: lines.length - 1, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual([undefined, "u1", "a1"]);
    expect(plan.headUuid).toBe("a1");
  });

  it("never mutates the lines it was given", () => {
    const lines = conversation();
    const before = JSON.stringify(lines);
    planFork(lines, { at: 4, newSessionId: NEW_SESSION });

    expect(JSON.stringify(lines)).toBe(before);
  });
});

describe("projectSlug", () => {
  it("replaces every character outside [a-zA-Z0-9] with a dash", () => {
    expect(projectSlug("/home/dev/app")).toBe("-home-dev-app");
    expect(projectSlug("/Users/dev/Desktop/PressW/1 on 1's")).toBe(
      "-Users-dev-Desktop-PressW-1-on-1-s",
    );
    expect(projectSlug("/a/b_c.d (e)")).toBe("-a-b-c-d--e-");
  });
});

describe("resolveTranscriptPath", () => {
  function projects(): { env: NodeJS.ProcessEnv; root: string } {
    const config = makeTempDir();
    const root = join(config, "projects");
    mkdirSync(root, { recursive: true });
    return { env: { CLAUDE_CONFIG_DIR: config }, root };
  }

  it("finds the transcript under the slug of the session cwd", () => {
    const { env, root } = projects();
    const dir = join(root, "-home-dev-app");
    mkdirSync(dir);
    writeFileSync(join(dir, `${OLD_SESSION}.jsonl`), "");

    expect(resolveTranscriptPath({ agentSessionId: OLD_SESSION, cwd: "/home/dev/app" }, env)).toBe(
      join(dir, `${OLD_SESSION}.jsonl`),
    );
  });

  it("falls back to scanning the project directories when the slug misses", () => {
    const { env, root } = projects();
    const dir = join(root, "-somewhere-else");
    mkdirSync(dir);
    writeFileSync(join(dir, `${OLD_SESSION}.jsonl`), "");

    expect(resolveTranscriptPath({ agentSessionId: OLD_SESSION, cwd: "/home/dev/app" }, env)).toBe(
      join(dir, `${OLD_SESSION}.jsonl`),
    );
  });

  it("returns null for an expired transcript or an unidentified session", () => {
    const { env } = projects();
    expect(resolveTranscriptPath({ agentSessionId: OLD_SESSION, cwd: "/home/dev/app" }, env)).toBe(
      null,
    );
    expect(resolveTranscriptPath({ cwd: "/home/dev/app" }, env)).toBe(null);
    expect(
      resolveTranscriptPath(
        { agentSessionId: OLD_SESSION, cwd: "/x" },
        {
          CLAUDE_CONFIG_DIR: join(makeTempDir(), "absent"),
        },
      ),
    ).toBe(null);
  });
});

describe("writeForkedTranscript", () => {
  it("writes the plan beside the source without touching it", () => {
    const dir = makeTempDir();
    const source = join(dir, `${OLD_SESSION}.jsonl`);
    const raw = `${conversation()
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`;
    writeFileSync(source, raw);
    const before = statSync(source).mtimeMs;

    const lines = readTranscriptLines(source);
    const plan = planFork(lines, { at: 4, newSessionId: NEW_SESSION });
    const written = writeForkedTranscript(plan.lines, NEW_SESSION, dir);

    expect(readFileSync(source, "utf8")).toBe(raw);
    expect(statSync(source).mtimeMs).toBe(before);
    expect(written).toBe(join(dir, `${NEW_SESSION}.jsonl`));
    expect(readTranscriptLines(written)).toHaveLength(5);
    expect(() => writeForkedTranscript(plan.lines, NEW_SESSION, dir)).toThrow(/EEXIST/);
  });
});

describe("checkForkSupport", () => {
  it("accepts a transcript that looks like the format it was built against", () => {
    expect(checkForkSupport(conversation(), "2.1.220")).toBe(null);
  });

  it("refuses an unreadable version, a new major, and an unfamiliar shape", () => {
    expect(checkForkSupport(conversation(), null)).toMatch(/claude --version/);
    expect(checkForkSupport(conversation(), "3.0.0")).toMatch(/verified against Claude Code 2/);
    expect(checkForkSupport([{ type: "mode", mode: "normal" }], "2.1.220")).toMatch(
      /no conversation lines with a uuid/,
    );
    expect(
      checkForkSupport([{ uuid: "u1", type: "user", sessionId: OLD_SESSION }], "2.1.220"),
    ).toMatch(/no parentUuid/);
  });
});

describe("cutIndexForEvent", () => {
  const lines = conversation();

  it("uses the recorded transcript uuid when the event carries one", () => {
    const event = makeEvent(9, 4000, "assistant.text", { text: "x", transcriptUuid: "a3" });
    expect(cutIndexForEvent(lines, event, new Date(START).toISOString())).toBe(4);
  });

  it("falls back to the request id, then to the timestamp", () => {
    const byRequest = makeEvent(9, 4000, "assistant.text", { text: "x", requestId: "req_2" });
    expect(cutIndexForEvent(lines, byRequest, new Date(START).toISOString())).toBe(4);

    const byTime = makeEvent(9, 3400, "assistant.text", { text: "x" });
    expect(cutIndexForEvent(lines, byTime, new Date(START).toISOString())).toBe(2);
  });

  it("cuts before the user line a prompt event produced", () => {
    const event = makeEvent(2, 7000, "prompt", { text: "  second prompt " });
    expect(cutIndexForEvent(lines, event, new Date(START).toISOString())).toBe(5);
  });

  it("returns null when nothing in the transcript precedes the event", () => {
    const event = makeEvent(0, 0, "prompt", { text: "unknown" });
    expect(cutIndexForEvent(lines, event, new Date(START - 60_000).toISOString())).toBe(null);
  });

  it("cuts before the tool_use block a tool.start names by toolUseId", () => {
    // t is 0, so the timestamp path would resolve to nothing at all: only the
    // toolUseId can produce an index here.
    const event = makeEvent(5, 0, "tool.start", { name: "Bash", input: {}, toolUseId: "toolu_2" });
    expect(cutIndexForEvent(lines, event, new Date(START).toISOString())).toBe(6);
  });

  it("cuts at the tool_result a tool.end names by toolUseId", () => {
    const event = makeEvent(6, 0, "tool.end", { name: "Bash", ok: true, toolUseId: "toolu_1" });
    expect(cutIndexForEvent(lines, event, new Date(START).toISOString())).toBe(3);
  });

  it("falls back to the timestamp for an unknown toolUseId and for an older recording", () => {
    const unknown = makeEvent(5, 3400, "tool.start", {
      name: "Bash",
      input: {},
      toolUseId: "toolu_gone",
    });
    expect(cutIndexForEvent(lines, unknown, new Date(START).toISOString())).toBe(2);

    const legacy = makeEvent(5, 3400, "tool.start", { name: "Bash", input: {} });
    expect(cutIndexForEvent(lines, legacy, new Date(START).toISOString())).toBe(2);
  });

  it("plans a prefix that drops the tool call and the result answering it", () => {
    const event = makeEvent(5, 0, "tool.start", { name: "Bash", input: {}, toolUseId: "toolu_2" });
    const cutIndex = cutIndexForEvent(lines, event, new Date(START).toISOString());
    const plan = planFork(lines, { at: cutIndex ?? -1, newSessionId: NEW_SESSION });

    expect(uuids(plan)).toEqual(["u1", "a1", "a2", "u2", "a3", undefined, "u3"]);
    expect(plan.headUuid).toBe("u3");
    expect(JSON.stringify(plan.lines)).not.toContain("toolu_2");
  });

  it("walks back past a whole batch when the call was one of several at once", () => {
    clock = 0;
    const parallel = [
      userText("p1", null, "do both"),
      assistantText("b1", "p1", "calling both"),
      assistantToolUse("b2", "b1", "toolu_a"),
      assistantToolUse("b3", "b2", "toolu_b"),
      toolResult("p2", "b3", "toolu_a"),
      toolResult("p3", "p2", "toolu_b"),
      assistantText("b4", "p3", "both done"),
    ];
    const event = makeEvent(5, 0, "tool.start", { name: "Bash", input: {}, toolUseId: "toolu_b" });
    const cutIndex = cutIndexForEvent(parallel, event, new Date(START).toISOString());
    expect(cutIndex).toBe(2);

    // Cutting between the two calls would strand toolu_a unanswered, so the
    // plan backs off to before the batch rather than to the line asked for.
    const plan = planFork(parallel, { at: cutIndex ?? -1, newSessionId: NEW_SESSION });
    expect(uuids(plan)).toEqual(["p1", "b1"]);
    expect(plan.headUuid).toBe("b1");
    expect(plan.dropped).toBe(1);
  });
});

describe("forkPoints", () => {
  it("lists prompts, tool calls and assistant replies with their seq and offset", () => {
    const events = [
      makeEvent(0, 0, "session.title", { title: "t" }),
      makeEvent(1, 1200, "prompt", { text: "do the thing" }),
      makeEvent(2, 1800, "tool.start", {
        name: "Bash",
        input: { command: "pnpm test", description: "run the tests" },
        toolUseId: "toolu_1",
      }),
      makeEvent(3, 1900, "tool.start", { name: "Read", input: { file_path: "/a/b.ts" } }),
      makeEvent(4, 1950, "tool.start", { name: "Mystery", input: { odd: "shape" } }),
      makeEvent(5, 1980, "tool.end", { name: "Bash", ok: true, toolUseId: "toolu_1" }),
      makeEvent(6, 2400, "usage", {
        model: "m",
        requestId: "r",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
        },
      }),
      makeEvent(7, 3600, "assistant.text", { text: "on it" }),
    ];

    // tool.end resolves precisely too, but it is not offered as a fork point:
    // the state after a call is the state the next point already forks from.
    expect(forkPoints(events)).toEqual([
      { seq: 1, t: 1200, kind: "prompt", preview: "do the thing" },
      { seq: 2, t: 1800, kind: "tool", preview: "Bash: pnpm test" },
      { seq: 3, t: 1900, kind: "tool", preview: "Read: /a/b.ts" },
      { seq: 4, t: 1950, kind: "tool", preview: "Mystery" },
      { seq: 7, t: 3600, kind: "assistant", preview: "on it" },
    ]);
  });
});
