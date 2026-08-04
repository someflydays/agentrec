import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHookSettings,
  commandSupportsHooks,
  type HookInjection,
  hookCommandLine,
  injectHookSettings,
} from "../src/recorder/hooks-settings.js";

const EXEC_PATH = "/usr/local/bin/node";
const CLI_ENTRY = "/home/dev/my apps/agentrec/dist/index.js";

interface ParsedSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

let tempDirs: string[] = [];

function settingsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentrec-settings-"));
  tempDirs.push(dir);
  const path = join(dir, "settings.json");
  writeFileSync(path, contents);
  return path;
}

function inject(command: string[]): HookInjection {
  return injectHookSettings(command, EXEC_PATH, CLI_ENTRY);
}

/** The injected settings, wherever in argv they ended up. */
function injectedSettings(injection: HookInjection): ParsedSettings {
  const { argv } = injection;
  // The merged value is on the last --settings, which is the one Claude Code reads.
  const index = argv.lastIndexOf("--settings");
  const raw =
    index === -1
      ? (argv.find((arg) => arg.startsWith("--settings="))?.slice("--settings=".length) ?? "")
      : (argv[index + 1] ?? "");
  return JSON.parse(raw) as ParsedSettings;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

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
      "PostToolUseFailure",
      "Notification",
      "Stop",
      "SubagentStop",
      "SessionEnd",
    ]);
  });

  it("matches all tools, and omits the matcher where it is not allowed", () => {
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.PostToolUseFailure?.[0]?.matcher).toBe("*");
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

describe("injectHookSettings", () => {
  it("appends the settings as a parseable JSON literal", () => {
    const injection = inject(["claude", "--continue"]);

    expect(injection.warning).toBeUndefined();
    expect(injection.argv.slice(0, 3)).toEqual(["claude", "--continue", "--settings"]);
    const settings = injectedSettings(injection);
    expect(Object.keys(settings.hooks ?? {})).toHaveLength(9);
    expect(settings.hooks?.PostToolUseFailure).toEqual(
      buildHookSettings(EXEC_PATH, CLI_ENTRY).hooks.PostToolUseFailure,
    );
  });

  it("never mutates the command it was given", () => {
    const command = ["claude"];
    inject(command);

    expect(command).toEqual(["claude"]);
  });
});

describe("injectHookSettings with a user --settings", () => {
  const userSettings = JSON.stringify({
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }],
    },
  });

  it("merges into a settings file, keeping everything it already held", () => {
    const path = settingsFile(userSettings);
    const injection = inject(["claude", "--settings", path, "--verbose"]);

    expect(injection.warning).toBeUndefined();
    // Still exactly one --settings, in the position the user put it.
    expect(injection.argv.filter((arg) => arg.startsWith("--settings"))).toHaveLength(1);
    expect(injection.argv[1]).toBe("--settings");
    expect(injection.argv[3]).toBe("--verbose");
    const settings = injectedSettings(injection);
    expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(Object.keys(settings.hooks ?? {})).toHaveLength(9);
  });

  it("merges into a JSON literal, in both spellings of the option", () => {
    const spaced = inject(["claude", "--settings", userSettings]);
    const inline = inject(["claude", `--settings=${userSettings}`]);

    expect(spaced.warning).toBeUndefined();
    expect(inline.warning).toBeUndefined();
    expect(inline.argv).toHaveLength(2);
    expect(inline.argv[1]?.startsWith("--settings=")).toBe(true);
    expect(injectedSettings(spaced)).toEqual(injectedSettings(inline));
  });

  it("appends our hook group to the user's for the same event", () => {
    const ours = buildHookSettings(EXEC_PATH, CLI_ENTRY);
    const settings = injectedSettings(inject(["claude", "--settings", userSettings]));

    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: "command", command: "say done" }] },
      ...(ours.hooks.Stop ?? []),
    ]);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "audit" }] },
      ...(ours.hooks.PreToolUse ?? []),
    ]);
    expect(settings.hooks?.SessionEnd).toEqual(ours.hooks.SessionEnd);
  });

  it("merges into the last --settings, which is the one Claude Code honours", () => {
    const first = settingsFile('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"a"}]}]}}');
    const last = settingsFile('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"b"}]}]}}');
    const injection = inject(["claude", "--settings", first, "--settings", last]);
    const settings = injectedSettings(injection);

    expect(injection.argv[2]).toBe(first);
    expect(settings.hooks?.Stop).toHaveLength(2);
    expect(JSON.stringify(settings.hooks?.Stop)).toContain('"command":"b"');
  });

  it("records the terminal only when the settings cannot be read or merged", () => {
    const missing = inject(["claude", "--settings", "/nope/settings.json"]);
    const broken = inject(["claude", "--settings", settingsFile("{ not json")]);
    const notAnObject = inject(["claude", "--settings", "[1,2]"]);
    const unmergeable = inject(["claude", "--settings", '{"hooks":{"Stop":"nope"}}']);

    for (const injection of [missing, broken, notAnObject, unmergeable]) {
      expect(injection.warning).toMatch(/without hooks$/);
      expect(injection.argv).toHaveLength(3);
      expect(injection.argv).not.toContain(JSON.stringify(buildHookSettings(EXEC_PATH, CLI_ENTRY)));
    }
    expect(unmergeable.warning).toMatch(/cannot merge/);
  });

  it("detects a dangling option that would swallow our own settings", () => {
    const model = inject(["claude", "--model"]);
    const dangling = inject(["claude", "--settings"]);
    const flag = inject(["claude", "--continue"]);

    expect(model.warning).toMatch(/^--model expects a value/);
    expect(model.argv).toEqual(["claude", "--model"]);
    expect(dangling.warning).toMatch(/^--settings expects a value/);
    expect(dangling.argv).toEqual(["claude", "--settings"]);
    expect(flag.warning).toBeUndefined();
  });
});
