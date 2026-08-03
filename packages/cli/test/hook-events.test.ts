import { describe, expect, it } from "vitest";
import { mapHookPayload } from "../src/recorder/hook-events.js";

const base = {
  session_id: "8f2c1b2e-0000-4000-8000-000000000000",
  transcript_path: "/home/dev/.claude/projects/-home-dev-app/8f2c1b2e.jsonl",
  cwd: "/home/dev/app",
};

describe("mapHookPayload", () => {
  it("returns the transcript path and agent session id without an event for SessionStart", () => {
    const mapped = mapHookPayload({ ...base, hook_event_name: "SessionStart", source: "startup" });
    expect(mapped.events).toEqual([]);
    expect(mapped.transcriptPath).toBe(base.transcript_path);
    expect(mapped.agentSessionId).toBe(base.session_id);
  });

  it("maps UserPromptSubmit to a prompt event", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "add a test",
    });
    expect(mapped.events).toEqual([{ type: "prompt", data: { text: "add a test" } }]);
  });

  it("maps PreToolUse to a tool.start event", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_1",
    });
    expect(mapped.events).toEqual([
      {
        type: "tool.start",
        data: { name: "Bash", input: { command: "ls" }, toolUseId: "toolu_1" },
      },
    ]);
  });

  it("keeps a missing tool input addressable as null", () => {
    const mapped = mapHookPayload({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(mapped.events).toEqual([{ type: "tool.start", data: { name: "Bash", input: null } }]);
  });

  it("maps PostToolUse to tool.end with a stringified response", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "a\nb" },
      tool_use_id: "toolu_1",
    });
    expect(mapped.events).toEqual([
      {
        type: "tool.end",
        data: { name: "Bash", ok: true, output: '{"stdout":"a\\nb"}', toolUseId: "toolu_1" },
      },
    ]);
  });

  it("reads failure only from an explicit success flag", () => {
    const failed = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
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

  it("truncates oversized tool output", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { stdout: "x".repeat(40_000) },
    });
    const data = mapped.events[0]?.data as { output?: string };
    expect(data.output).toHaveLength(16 * 1024 + "…[truncated]".length);
    expect(data.output?.endsWith("…[truncated]")).toBe(true);
  });

  it("derives a file.change alongside tool.end for a successful Write", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/home/dev/app/a.ts", content: "export const a = 1;\n" },
      tool_response: { filePath: "/home/dev/app/a.ts" },
      tool_use_id: "toolu_2",
    });
    expect(mapped.events.map((event) => event.type)).toEqual(["tool.end", "file.change"]);
    expect(mapped.events[1]?.data).toMatchObject({
      path: "/home/dev/app/a.ts",
      kind: "create",
      toolUseId: "toolu_2",
    });
  });

  it("derives no file.change for a failed write", () => {
    const mapped = mapHookPayload({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/home/dev/app/a.ts", content: "x" },
      tool_response: { success: false },
    });
    expect(mapped.events.map((event) => event.type)).toEqual(["tool.end"]);
  });

  it("maps notifications and turn boundaries", () => {
    expect(
      mapHookPayload({ ...base, hook_event_name: "Notification", message: "waiting" }).events,
    ).toEqual([{ type: "notification", data: { message: "waiting" } }]);
    expect(mapHookPayload({ ...base, hook_event_name: "Stop" }).events).toEqual([
      { type: "turn.end", data: {} },
    ]);
    expect(mapHookPayload({ ...base, hook_event_name: "SubagentStop" }).events).toEqual([
      { type: "subagent.end", data: {} },
    ]);
    expect(mapHookPayload({ ...base, hook_event_name: "SessionEnd" }).events).toEqual([]);
  });

  it("drops known hooks whose payload fields are missing", () => {
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit" }).events).toEqual([]);
    expect(mapHookPayload({ hook_event_name: "PostToolUse" }).events).toEqual([]);
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
