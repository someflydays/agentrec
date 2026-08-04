# Real Claude Code hook payloads

Every file here is a hook payload **captured from a real Claude Code run**, not
hand-written. They exist so `hook-events.test.ts` asserts the recorder's mapping
against what Claude Code actually sends, rather than against what we assumed it
sends. See issue #9.

## Provenance

| | |
| --- | --- |
| Claude Code version | `2.1.221` |
| Model | `claude-haiku` (via `--model haiku`) |
| Captured | 2026-08-03 |
| Platform | macOS (darwin 25.3.0) |
| Mode | `claude -p` (non-interactive), `--permission-mode` left at `default` |

Capture method: a `sh` hook that appends its stdin to a file, registered for
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd` and
`PreCompact` via `--settings`, then two `claude -p` runs in a throwaway
directory:

1. `echo hooktest` (Bash, succeeds) → read `package.json` (Read, succeeds) →
   `cat /nonexistent/...` (Bash, **fails**).
2. `Write notes.txt` → `Edit seed.ts` → read a nonexistent path (Read,
   **fails**) → `echo done`.

`CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` were unset before launching so the
child ran as a top-level session.

## Redaction

The only edit applied to the captured bytes is the capturing machine's OS
username, replaced throughout with `dev`. Field names, nesting, ordering, ids,
and value shapes are exactly as received. Files are pretty-printed; Claude Code
delivers them minified.

## What these pin down

- **`tool_use_id` is real and stable.** It is present on `PreToolUse`,
  `PostToolUse` and `PostToolUseFailure`, the Pre/Post pair for one call share
  the same value, and that value is byte-identical to the `tool_use` block `id`
  in the session transcript. Verified against the transcript each run wrote.
- **`tool_response` has no `success` field**, on any tool observed. Failure is
  not signalled inside `tool_response`.
- **Failures arrive as a different event.** A failing Bash or Read fires
  `PostToolUseFailure` (top-level `error`, `is_interrupt`, and *no*
  `tool_response`), never `PostToolUse`. `PostToolUse` fires only on success.
- Per-tool `tool_response` shapes differ: Bash returns
  `{stdout, stderr, interrupted, isImage, noOutputExpected}`, Read returns
  `{type, file: {...}}`, Write returns `{type, filePath, content,
  structuredPatch, originalFile, userModified}`, Edit returns
  `{filePath, oldString, newString, originalFile, structuredPatch, ...}`.

## Not captured

`Notification` and `SubagentStop` did not fire during these runs (`-p` mode with
pre-approved tools and no subagent). Their mapping is still driven by the
documented shape only — see the header comment in `hook-events.ts`.

## Refreshing

Re-run the capture against a newer Claude Code, overwrite these files, and
update the version in the table above. If a field disappears, the tests should
fail loudly rather than be edited to match.
