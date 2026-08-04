import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapHookPayload } from "../src/recorder/hook-events.js";

/**
 * These fixtures are payloads captured from real Claude Code 2.1.221 runs, so
 * they fail loudly if a future version renames or drops a field the mapping
 * depends on. See fixtures/hook-payloads/README.md for provenance.
 */
function fixture(name: string): Record<string, unknown> {
  const url = new URL(`./fixtures/hook-payloads/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

const base = {
  session_id: "8f2c1b2e-0000-4000-8000-000000000000",
  transcript_path: "/home/dev/.claude/projects/-home-dev-app/8f2c1b2e.jsonl",
  cwd: "/home/dev/app",
};

describe("mapHookPayload against real captured payloads", () => {
  it("carries the transcript path and agent session id off every hook", () => {
    for (const name of ["session-start", "user-prompt-submit", "pre-tool-use-bash", "stop"]) {
      const payload = fixture(name);
      const mapped = mapHookPayload(payload);
      expect(mapped.transcriptPath).toBe(payload.transcript_path);
      expect(mapped.agentSessionId).toBe(payload.session_id);
    }
  });

  it("emits no event for the session boundaries", () => {
    expect(mapHookPayload(fixture("session-start")).events).toEqual([]);
    expect(mapHookPayload(fixture("session-end")).events).toEqual([]);
  });

  it("maps a real UserPromptSubmit to a prompt event", () => {
    const payload = fixture("user-prompt-submit");
    expect(mapHookPayload(payload).events).toEqual([
      { type: "prompt", data: { text: payload.prompt } },
    ]);
  });

  it("maps a real Stop to a turn boundary", () => {
    expect(mapHookPayload(fixture("stop")).events).toEqual([{ type: "turn.end", data: {} }]);
  });

  it("maps a real PreToolUse to tool.start with the id and unmodified input", () => {
    const payload = fixture("pre-tool-use-bash");
    expect(mapHookPayload(payload).events).toEqual([
      {
        type: "tool.start",
        data: {
          name: "Bash",
          input: { command: "echo hooktest", description: "Echo hooktest" },
          toolUseId: "toolu_015Q6AhzX2K7agNvgRrkqAs7",
        },
      },
    ]);
  });

  /**
   * The fact issue #13 rests on: one tool call's PreToolUse and PostToolUse
   * carry the same tool_use_id, and it equals the transcript's tool_use block
   * id, so tool.start and tool.end correlate without guessing by name or time.
   */
  it("gives the pre and post hooks of one call the same tool use id", () => {
    const start = mapHookPayload(fixture("pre-tool-use-bash")).events[0];
    const end = mapHookPayload(fixture("post-tool-use-bash")).events[0];
    expect(start?.data).toMatchObject({ toolUseId: "toolu_015Q6AhzX2K7agNvgRrkqAs7" });
    expect(end?.data).toMatchObject({ toolUseId: "toolu_015Q6AhzX2K7agNvgRrkqAs7" });

    const writeStart = mapHookPayload(fixture("pre-tool-use-write")).events[0];
    const writeEnd = mapHookPayload(fixture("post-tool-use-write")).events[0];
    expect(writeStart?.data).toMatchObject({ toolUseId: "toolu_01KZkWNVTSbPy3Bj7DrCZtve" });
    expect(writeEnd?.data).toMatchObject({ toolUseId: "toolu_01KZkWNVTSbPy3Bj7DrCZtve" });
  });

  it("maps a successful Bash PostToolUse to tool.end with the stringified response", () => {
    const mapped = mapHookPayload(fixture("post-tool-use-bash"));
    expect(mapped.events).toEqual([
      {
        type: "tool.end",
        data: {
          name: "Bash",
          ok: true,
          output:
            '{"stdout":"hooktest","stderr":"","interrupted":false,"isImage":false,' +
            '"noOutputExpected":false}',
          toolUseId: "toolu_015Q6AhzX2K7agNvgRrkqAs7",
        },
      },
    ]);
  });

  it("treats a real Read response as success despite carrying no success field", () => {
    const payload = fixture("post-tool-use-read");
    expect(payload.tool_response).not.toHaveProperty("success");
    const data = mapHookPayload(payload).events[0]?.data as { ok: boolean; output?: string };
    expect(data.ok).toBe(true);
    expect(data.output).toContain('"numLines":2');
  });

  it("derives a file.change from a real Write, whose response also has no success field", () => {
    const payload = fixture("post-tool-use-write");
    expect(payload.tool_response).not.toHaveProperty("success");
    const mapped = mapHookPayload(payload);
    expect(mapped.events.map((event) => event.type)).toEqual(["tool.end", "file.change"]);
    expect(mapped.events[1]?.data).toMatchObject({
      kind: "create",
      toolUseId: "toolu_01KZkWNVTSbPy3Bj7DrCZtve",
      path: (payload.tool_input as { file_path: string }).file_path,
    });
  });

  /**
   * The diff spans only the replaced substring from tool_input, not the whole
   * line: the richer originalFile/structuredPatch that the real tool_response
   * carries is not read today.
   */
  it("derives a file.change from a real Edit", () => {
    const mapped = mapHookPayload(fixture("post-tool-use-edit"));
    expect(mapped.events.map((event) => event.type)).toEqual(["tool.end", "file.change"]);
    const change = mapped.events[1]?.data as { kind: string; diff: string };
    expect(change.kind).toBe("edit");
    expect(change.diff).toContain("-const a = 1");
    expect(change.diff).toContain("+const a = 2");
  });

  /**
   * A tool that fails fires PostToolUseFailure, never PostToolUse, so this is
   * the only path that can close out a failed call's tool.start.
   */
  it("maps a real failed Bash to a failed tool.end carrying the error text", () => {
    const mapped = mapHookPayload(fixture("post-tool-use-failure-bash"));
    expect(mapped.events).toEqual([
      {
        type: "tool.end",
        data: {
          name: "Bash",
          ok: false,
          output:
            "Exit code 1\ncat: /nonexistent/definitely-missing-file-xyz: No such file or directory",
          toolUseId: "toolu_01BTw5CAxL6L8wrNtz9Q13mg",
        },
      },
    ]);
  });

  it("maps a real failed Read the same way and keeps the transcript fields", () => {
    const payload = fixture("post-tool-use-failure-read");
    const mapped = mapHookPayload(payload);
    expect(mapped.agentSessionId).toBe(payload.session_id);
    const data = mapped.events[0]?.data as { ok: boolean; output?: string; toolUseId?: string };
    expect(data.ok).toBe(false);
    expect(data.toolUseId).toBe("toolu_012VK1SBopLxSnYWJMrB9ZBW");
    expect(data.output).toContain("File does not exist.");
  });

  it("never derives a file.change from a failed write", () => {
    const failedWrite = {
      ...fixture("post-tool-use-failure-read"),
      tool_name: "Write",
      tool_input: { file_path: "/home/dev/app/a.ts", content: "x" },
    };
    expect(mapHookPayload(failedWrite).events.map((event) => event.type)).toEqual(["tool.end"]);
  });
});

describe("mapHookPayload defensive handling", () => {
  it("keeps a missing tool input addressable as null", () => {
    const mapped = mapHookPayload({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(mapped.events).toEqual([{ type: "tool.start", data: { name: "Bash", input: null } }]);
  });

  it("omits the tool use id rather than inventing one when it is absent", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { stdout: "hi" },
    });
    expect(mapped.events[0]?.data).not.toHaveProperty("toolUseId");
  });

  /**
   * No built-in tool emitted `success` in 2.1.221, but MCP output reaches the
   * hook unvalidated, so an explicit false is still respected.
   */
  it("still reads failure from an explicit success flag", () => {
    const failed = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "mcp__thing__do",
      tool_response: { success: false, error: "boom" },
    });
    expect(failed.events[0]?.data).toMatchObject({ ok: false });

    const stringResponse = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: "done",
    });
    expect(stringResponse.events[0]?.data).toMatchObject({ ok: true, output: '"done"' });
  });

  it("truncates oversized tool output on both the success and failure paths", () => {
    const succeeded = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { stdout: "x".repeat(40_000) },
    });
    const failed = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      error: "x".repeat(40_000),
    });
    for (const mapped of [succeeded, failed]) {
      const data = mapped.events[0]?.data as { output?: string };
      expect(data.output).toHaveLength(16 * 1024 + "…[truncated]".length);
      expect(data.output?.endsWith("…[truncated]")).toBe(true);
    }
  });

  it("still records a failed tool.end when the error text is missing", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
    });
    expect(mapped.events).toEqual([
      { type: "tool.end", data: { name: "Bash", ok: false, toolUseId: "toolu_1" } },
    ]);
  });

  it("maps notifications and the subagent boundary", () => {
    expect(
      mapHookPayload({ ...base, hook_event_name: "Notification", message: "waiting" }).events,
    ).toEqual([{ type: "notification", data: { message: "waiting" } }]);
    expect(mapHookPayload({ ...base, hook_event_name: "SubagentStop" }).events).toEqual([
      { type: "subagent.end", data: {} },
    ]);
  });

  it("drops known hooks whose payload fields are missing", () => {
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit" }).events).toEqual([]);
    expect(mapHookPayload({ hook_event_name: "PostToolUse" }).events).toEqual([]);
    expect(mapHookPayload({ hook_event_name: "PostToolUseFailure" }).events).toEqual([]);
    expect(mapHookPayload({ hook_event_name: "Notification", message: 42 }).events).toEqual([]);
  });

  it("returns an empty result for unknown or malformed payloads", () => {
    expect(mapHookPayload({ hook_event_name: "PreCompact" })).toEqual({ events: [] });
    expect(mapHookPayload({ ...base, hook_event_name: "Nonsense" })).toEqual({ events: [] });
    expect(mapHookPayload({})).toEqual({ events: [] });
    expect(mapHookPayload(null)).toEqual({ events: [] });
    expect(mapHookPayload("Stop")).toEqual({ events: [] });
    expect(mapHookPayload([{ hook_event_name: "Stop" }])).toEqual({ events: [] });
  });
});
