import { describe, expect, it } from "vitest";
import {
  buildHookSettings,
  commandSupportsHooks,
  hookCommandLine,
  hookSettingsArgs,
} from "../src/recorder/hooks-settings.js";

const EXEC_PATH = "/usr/local/bin/node";
const CLI_ENTRY = "/home/dev/my apps/agentrec/dist/index.js";

describe("hookCommandLine", () => {
  it("quotes both paths and calls the hidden subcommand", () => {
    expect(hookCommandLine(EXEC_PATH, CLI_ENTRY)).toBe(
      '"/usr/local/bin/node" "/home/dev/my apps/agentrec/dist/index.js" _hook',
    );
  });
});

describe("buildHookSettings", () => {
  const settings = buildHookSettings(EXEC_PATH, CLI_ENTRY);

  it("covers every hook the recorder listens for", () => {
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SubagentStop",
      "SessionEnd",
    ]);
  });

  it("matches all tools, and omits the matcher where it is not allowed", () => {
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.Stop?.[0]).not.toHaveProperty("matcher");
    expect(settings.hooks.SessionStart?.[0]).not.toHaveProperty("matcher");
  });

  it("registers one timed command hook per group", () => {
    for (const groups of Object.values(settings.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks).toEqual([
        { type: "command", command: hookCommandLine(EXEC_PATH, CLI_ENTRY), timeout: 10 },
      ]);
    }
  });
});

describe("hookSettingsArgs", () => {
  it("passes the settings as a parseable JSON literal", () => {
    const args = hookSettingsArgs(EXEC_PATH, CLI_ENTRY);
    expect(args[0]).toBe("--settings");
    expect(args[1]).toBeDefined();
    const parsed = JSON.parse(args[1] ?? "") as ReturnType<typeof buildHookSettings>;
    expect(Object.keys(parsed.hooks)).toHaveLength(8);
    expect(parsed.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain("_hook");
  });
});

describe("commandSupportsHooks", () => {
  it("recognizes claude by its basename only", () => {
    expect(commandSupportsHooks(["claude"])).toBe(true);
    expect(commandSupportsHooks(["/opt/homebrew/bin/claude", "--continue"])).toBe(true);
    expect(commandSupportsHooks(["claude-code"])).toBe(true);
    expect(commandSupportsHooks(["/home/claude/bin/codex"])).toBe(false);
    expect(commandSupportsHooks(["bash"])).toBe(false);
    expect(commandSupportsHooks([])).toBe(false);
  });
});
