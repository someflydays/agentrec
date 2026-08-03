import type { SessionEventData, SessionEventType } from "@agent-blackbox/core";
import { TRUNCATION_MARKER, truncate } from "../format.js";
import { deriveFileChange } from "./file-changes.js";
import { asNonEmptyString, asRecord } from "./json.js";

/**
 * Every Claude Code hook payload shares {session_id, transcript_path, cwd,
 * hook_event_name} plus per-event fields. Hooks are the only capture path that
 * cannot be retried, so an unrecognized or malformed payload yields an empty
 * result instead of an error.
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
