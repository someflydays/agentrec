import { basename } from "node:path";

/** Hidden CLI subcommand that forwards a hook payload to the recording session. */
export const HOOK_COMMAND_NAME = "_hook";

const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

/** Only tool hooks take a matcher; the others reject one. */
const MATCHED_EVENT_NAMES: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);

const HOOK_TIMEOUT_SECONDS = 10;

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

/**
 * `--settings` accepts a literal JSON string as well as a path, which keeps the
 * injected hooks out of the user's own settings files entirely.
 */
export function hookSettingsArgs(execPath: string, cliEntry: string): string[] {
  return ["--settings", JSON.stringify(buildHookSettings(execPath, cliEntry))];
}

export function commandSupportsHooks(command: string[]): boolean {
  const file = command[0];
  return file !== undefined && basename(file).toLowerCase().includes("claude");
}
