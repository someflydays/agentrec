import type { SessionEventData, SessionEventType } from "@agentrec/core";
import { TRUNCATION_MARKER, truncate } from "../format.js";
import { deriveFileChange } from "./file-changes.js";
import { asNonEmptyString, asRecord } from "./json.js";

/**
 * Every Claude Code hook payload shares {session_id, transcript_path, cwd,
 * hook_event_name} plus per-event fields. Hooks are the only capture path that
 * cannot be retried, so an unrecognized or malformed payload yields an empty
 * result instead of an error.
 *
 * The field assumptions below were checked against the reference at
 * https://code.claude.com/docs/en/hooks and against payloads captured from real
 * runs of Claude Code 2.1.221 (see test/fixtures/hook-payloads/):
 *
 * - DOCUMENTED and OBSERVED: `tool_use_id` is present on PreToolUse,
 *   PostToolUse and PostToolUseFailure, is shared by the pre/post pair of one
 *   call, and is byte-identical to the `tool_use` block id in the transcript.
 *   That equality is what lets tool.start/tool.end correlate and lets a fork cut
 *   the conversation at an exact tool call.
 * - DOCUMENTED and OBSERVED: PostToolUse fires only after a tool *succeeds*. A
 *   tool that fails fires PostToolUseFailure instead, which carries a top-level
 *   `error` string and no `tool_response` at all.
 * - DOCUMENTED but NOT OBSERVED: the reference's PostToolUse example shows
 *   `tool_response.success`, but no built-in tool emitted that field in 2.1.221.
 *   It is still honoured when present because MCP tool output is passed through
 *   without schema validation.
 * - OBSERVED: `tool_response` has a different shape per tool (Bash returns
 *   stdout/stderr, Read returns a nested `file`, Write and Edit return a
 *   structuredPatch), so it is only ever stored opaquely.
 * - ASSUMED: the Notification and SubagentStop shapes, which did not fire during
 *   capture and so follow the documented fields alone.
 */
const MAX_TOOL_OUTPUT_CHARS = 16 * 1024;

/** A session event before the writer stamps it with a sequence number and timestamp. */
export type PendingEvent = {
  [T in SessionEventType]: { type: T; data: SessionEventData<T> };
}[SessionEventType];

export interface MappedHookPayload {
  events: PendingEvent[];
  transcriptPath?: string;
  agentSessionId?: string;
}

const EMPTY: MappedHookPayload = { events: [] };

function toolUseIdOf(root: Record<string, unknown>): { toolUseId?: string } {
  const toolUseId = asNonEmptyString(root.tool_use_id);
  return toolUseId !== undefined ? { toolUseId } : {};
}

function stringifyResponse(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : undefined;
  } catch {
    return undefined;
  }
}

function mapPostToolUse(root: Record<string, unknown>): PendingEvent[] {
  const name = asNonEmptyString(root.tool_name);
  if (name === undefined) return [];
  const ids = toolUseIdOf(root);
  const response = root.tool_response;
  // This hook only fires on success; `success` is honoured for MCP tools, whose
  // output reaches the hook without schema validation.
  const ok = asRecord(response)?.success !== false;
  const json = response === undefined ? undefined : stringifyResponse(response);
  const output =
    json === undefined ? undefined : truncate(json, MAX_TOOL_OUTPUT_CHARS, TRUNCATION_MARKER);

  const events: PendingEvent[] = [
    {
      type: "tool.end",
      data: { name, ok, ...(output !== undefined ? { output } : {}), ...ids },
    },
  ];
  // A failed write never happened, so no file.change is derived for it.
  const change = ok ? deriveFileChange(name, root.tool_input) : undefined;
  if (change !== undefined) {
    events.push({ type: "file.change", data: { ...change, ...ids } });
  }
  return events;
}

/**
 * Without this the tool.start of every failed call would dangle unterminated,
 * and a failure would be indistinguishable from a crash mid-call.
 */
function mapPostToolUseFailure(root: Record<string, unknown>): PendingEvent[] {
  const name = asNonEmptyString(root.tool_name);
  if (name === undefined) return [];
  // `error` is already human-readable prose, unlike the JSON-encoded success
  // response, so it is stored verbatim for the timeline and search to show.
  const error = asNonEmptyString(root.error);
  const output =
    error === undefined ? undefined : truncate(error, MAX_TOOL_OUTPUT_CHARS, TRUNCATION_MARKER);
  // No file.change: a write that failed never happened.
  return [
    {
      type: "tool.end",
      data: { name, ok: false, ...(output !== undefined ? { output } : {}), ...toolUseIdOf(root) },
    },
  ];
}

/** Undefined signals an unknown hook, which is distinct from a known hook with no events. */
function mapEvents(
  hookEventName: string,
  root: Record<string, unknown>,
): PendingEvent[] | undefined {
  switch (hookEventName) {
    case "SessionStart":
    case "SessionEnd":
      return [];
    case "UserPromptSubmit": {
      const text = asNonEmptyString(root.prompt);
      return text === undefined ? [] : [{ type: "prompt", data: { text } }];
    }
    case "PreToolUse": {
      const name = asNonEmptyString(root.tool_name);
      if (name === undefined) return [];
      return [
        {
          type: "tool.start",
          data: { name, input: root.tool_input ?? null, ...toolUseIdOf(root) },
        },
      ];
    }
    case "PostToolUse":
      return mapPostToolUse(root);
    case "PostToolUseFailure":
      return mapPostToolUseFailure(root);
    case "Notification": {
      const message = asNonEmptyString(root.message);
      return message === undefined ? [] : [{ type: "notification", data: { message } }];
    }
    case "Stop":
      return [{ type: "turn.end", data: {} }];
    case "SubagentStop":
      return [{ type: "subagent.end", data: {} }];
    default:
      return undefined;
  }
}

export function mapHookPayload(payload: unknown): MappedHookPayload {
  const root = asRecord(payload);
  if (root === undefined) return EMPTY;
  const hookEventName = asNonEmptyString(root.hook_event_name);
  if (hookEventName === undefined) return EMPTY;
  const events = mapEvents(hookEventName, root);
  if (events === undefined) return EMPTY;

  // Every hook carries these, so the tailer can start from whichever arrives
  // first even if SessionStart was missed.
  const transcriptPath = asNonEmptyString(root.transcript_path);
  const agentSessionId = asNonEmptyString(root.session_id);
  return {
    events,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
  };
}
