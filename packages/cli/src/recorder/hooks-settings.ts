import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { asRecord } from "./json.js";

/** Hidden CLI subcommand that forwards a hook payload to the recording session. */
export const HOOK_COMMAND_NAME = "_hook";

const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  // PostToolUse fires only for tools that succeeded; a failed one is reported
  // here instead, and without it a failed call has a tool.start and no end.
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

/** Only tool hooks take a matcher; the others reject one. */
const MATCHED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

const HOOK_TIMEOUT_SECONDS = 10;

const SETTINGS_OPTION = "--settings";
const SETTINGS_PREFIX = `${SETTINGS_OPTION}=`;

/** Said at the end of every warning: hooks are off, but the terminal is still recorded. */
const CAST_ONLY = "recording the terminal only, without hooks";

/**
 * Claude Code options that consume the argument after them. Our `--settings` is
 * appended to the command, so a command ending in one of these would swallow it
 * instead of recording anything. The agent publishes no machine-readable option
 * table, so this is a best effort taken from `claude --help` (2.1.x): an option
 * missing from it is assumed to be a flag, which is the common case
 * (`--continue`, `--resume`, `--verbose`) and the one that must keep working.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--add-dir",
  "--agent",
  "--agents",
  "--allowed-tools",
  "--allowedTools",
  "--append-system-prompt",
  "--autocompact",
  "--betas",
  "--debug-file",
  "--disallowed-tools",
  "--disallowedTools",
  "--effort",
  "--fallback-model",
  "--file",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "--name",
  "-n",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  SETTINGS_OPTION,
  "--system-prompt",
  "--tools",
]);

interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookSettings {
  hooks: Record<string, HookGroup[]>;
}

export function hookCommandLine(execPath: string, cliEntry: string): string {
  // Claude Code runs hook commands through a shell, so both paths must be quoted.
  return `${JSON.stringify(execPath)} ${JSON.stringify(cliEntry)} ${HOOK_COMMAND_NAME}`;
}

export function buildHookSettings(execPath: string, cliEntry: string): HookSettings {
  const command: HookCommand = {
    type: "command",
    command: hookCommandLine(execPath, cliEntry),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  const hooks: Record<string, HookGroup[]> = {};
  for (const name of HOOK_EVENT_NAMES) {
    hooks[name] = [
      MATCHED_EVENT_NAMES.has(name) ? { matcher: "*", hooks: [command] } : { hooks: [command] },
    ];
  }
  return { hooks };
}

export function commandSupportsHooks(command: readonly string[]): boolean {
  const file = command[0];
  return file !== undefined && basename(file).toLowerCase().includes("claude");
}

export interface HookInjection {
  /** argv to run: the command with our hooks added, or unchanged when they could not be. */
  argv: string[];
  /** Set when the hooks were left out, explaining why. */
  warning?: string;
}

interface SettingsArgument {
  /** Index of the argv element holding the value. */
  index: number;
  value: string;
  /** `--settings=x` is a single element, so the merged value replaces it in place. */
  inline: boolean;
}

/** A repeated `--settings` is last-wins, so that is the one our hooks are merged into. */
function findSettingsArgument(command: readonly string[]): SettingsArgument | undefined {
  let found: SettingsArgument | undefined;
  for (const [index, arg] of command.entries()) {
    if (arg === SETTINGS_OPTION) {
      const value = command[index + 1];
      // A trailing `--settings` with no value is caught as a dangling option.
      if (value !== undefined) found = { index: index + 1, value, inline: false };
    } else if (arg.startsWith(SETTINGS_PREFIX)) {
      found = { index, value: arg.slice(SETTINGS_PREFIX.length), inline: true };
    }
  }
  return found;
}

/** `--settings` takes a literal JSON object or a path to a file holding one. */
function readUserSettings(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  let text: string;
  if (trimmed.startsWith("{")) {
    text = trimmed;
  } else {
    try {
      text = readFileSync(trimmed, "utf8");
    } catch {
      return undefined;
    }
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Our hook groups are appended to whatever the user registered for the same
 * event, so their hooks keep running and ours run alongside them. Undefined
 * when the settings hold a `hooks` shape that cannot be appended to without
 * dropping part of it.
 */
function mergeHookSettings(
  settings: Record<string, unknown>,
  ours: HookSettings,
): Record<string, unknown> | undefined {
  const theirs = settings.hooks;
  if (theirs !== undefined && asRecord(theirs) === undefined) return undefined;
  const hooks: Record<string, unknown> = { ...asRecord(theirs) };
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const existing = hooks[event];
    if (existing === undefined) {
      hooks[event] = groups;
      continue;
    }
    if (!Array.isArray(existing)) return undefined;
    hooks[event] = [...existing, ...groups];
  }
  return { ...settings, hooks };
}

/**
 * Add the recorder's hooks to a command as a single `--settings` argument.
 * `--settings` accepts a literal JSON string, which keeps the injected hooks
 * out of the user's own settings files entirely. When the command already
 * carries a `--settings` of its own, that one is read and ours are merged into
 * it, because Claude Code honours only the last one it is given.
 *
 * Anything that cannot be done safely leaves the command untouched and returns
 * a warning: a session recorded without hooks still replays its terminal, which
 * is a far better outcome than refusing to run the agent or corrupting the
 * arguments the user asked for.
 */
export function injectHookSettings(
  command: readonly string[],
  execPath: string,
  cliEntry: string,
): HookInjection {
  const argv = [...command];
  const dangling = argv[argv.length - 1];
  if (dangling !== undefined && VALUE_OPTIONS.has(dangling)) {
    return {
      argv,
      warning: `${dangling} expects a value, so agentrec cannot add its own ${SETTINGS_OPTION}; ${CAST_ONLY}`,
    };
  }

  const ours = buildHookSettings(execPath, cliEntry);
  const existing = findSettingsArgument(argv);
  if (existing === undefined) {
    argv.push(SETTINGS_OPTION, JSON.stringify(ours));
    return { argv };
  }

  const settings = readUserSettings(existing.value);
  if (settings === undefined) {
    return {
      argv,
      warning: `could not read the ${SETTINGS_OPTION} passed to the recorded command; ${CAST_ONLY}`,
    };
  }
  const merged = mergeHookSettings(settings, ours);
  if (merged === undefined) {
    return {
      argv,
      warning: `the ${SETTINGS_OPTION} passed to the recorded command has hooks agentrec cannot merge with; ${CAST_ONLY}`,
    };
  }

  const json = JSON.stringify(merged);
  argv[existing.index] = existing.inline ? `${SETTINGS_PREFIX}${json}` : json;
  return { argv };
}
