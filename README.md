<div align="center">

# Agent Black Box

**Git has history for your code. Agent Black Box has history for how it was made.**

[![CI](https://github.com/PLACEHOLDER_GH_OWNER/agent-blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/PLACEHOLDER_GH_OWNER/agent-blackbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agent-blackbox/cli.svg?color=cb3837)](https://www.npmjs.com/package/@agent-blackbox/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-3fb950.svg)](package.json)

<img src="assets/demo.svg" alt="A terminal recording a Claude Code session, then replaying it on a scrubbable timeline" width="880">

</div>

## Why

A Claude Code session is the most detailed record of how a change got made — and it evaporates the
moment you close the terminal. Scrollback truncates, tool calls scroll past unrecorded, and "why did
it touch that file?" becomes unanswerable an hour later. Agent Black Box wraps the real `claude` CLI
in a PTY and records the whole session locally on three synchronized channels: the terminal
exactly as you saw it, every tool call with its inputs and outputs, and per-request token usage.
You get a replayable, scrubbable, shareable session — one file you can attach to a bug report so
someone else can watch what actually happened.

## Quick start

```bash
npm install -g @agent-blackbox/cli   # 1. install (Node >= 20.19)
agent-blackbox claude                # 2. record — claude behaves exactly as it always does
agent-blackbox ui                    # 3. replay in a local dashboard
```

Recordings land in `~/.agent-blackbox`. List them at any time:

```console
$ agent-blackbox ls
ID          TITLE                         AGE  DUR  PROMPTS  TOOLS  TOKENS  COST
01K1YQ7P8Z  Add watchdog timer to poller  4m   12m        3     41  284.1k  $0.42
01K1YMT3XR  Fix flaky auth test           2h    6m        2     18   96.4k  $0.15
```

No account, no daemon, no config file to write. `abb` is installed as a shorter alias, and
`npx @agent-blackbox/cli claude` works for a one-off recording without installing anything.

## Features

- Wraps the real `claude` CLI in a PTY — same TUI, same keybindings, same behavior.
- Records terminal **output** as a standard asciinema v2 cast. Keystrokes are never captured.
- Captures structured events via temporarily injected Claude Code hooks: prompts, every tool call
  with inputs and outputs, file edits as diffs, notifications, and turn boundaries.
- Tails the Claude Code transcript for assistant text, per-request token usage, and the session
  title.
- Event timeline synced to a terminal replay: play, pause, change speed, scrub to any moment.
- Per-model token and cost breakdown from a bundled pricing snapshot.
- File-change diffs collected per session, so you can see what the agent touched and how.
- Live sessions stream into the dashboard over SSE while they are still running.
- `export` bundles a session into one portable `.agentlog` file; `open` imports it anywhere.
- Everything is local: no telemetry, no network calls, dashboard bound to `127.0.0.1`.
- `agent-blackbox ls --json` for scripting.

## How it works

```mermaid
flowchart LR
  Y["you"]
  P["claude CLI<br/>wrapped in a PTY"]
  A["1 · terminal output<br/>asciinema v2 cast"]
  B["2 · injected hooks<br/>prompts · tools · diffs"]
  C["3 · transcript tail<br/>text · tokens · title"]
  S[("session store<br/>~/.agent-blackbox")]
  D["agent-blackbox ui<br/>replay on 127.0.0.1"]
  E["agent-blackbox export<br/>one .agentlog file"]

  Y --> P
  P --> A
  P --> B
  P --> C
  A --> S
  B --> S
  C --> S
  S --> D
  S --> E
  E -.->|"agent-blackbox open"| S
```

The three channels exist because no single one is sufficient. The PTY is ground truth for what you
actually saw, but it is a stream of escape codes with no structure. Hooks give structure — a real
list of tool calls with arguments — but say nothing about rendering or token spend. The transcript
carries the assistant's text and per-request usage. Recording all three against one clock means the
timeline and the terminal replay stay in sync, and every number in the cost breakdown traces back to
a specific request. See [docs/architecture.md](docs/architecture.md) for the details.

Hooks are injected per-invocation with Claude Code's `--settings` flag. Your own settings files are
never read, written, or modified.

## The session format

Each session is a directory named after a [ULID](https://github.com/ulid/spec) — sortable by start
time — under `~/.agent-blackbox/sessions/`:

| File            | What it is                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `meta.json`     | Session identity: id, wrapped command, cwd, start/end, exit code, title  |
| `events.jsonl`  | Append-only event log, one JSON object per line: `{seq, t, type, data}`  |
| `terminal.cast` | The terminal recording, asciinema v2, output and resize events only      |

`terminal.cast` is a plain asciicast, so `asciinema play`, `agg`, and anything else in that
ecosystem works on it directly — the dashboard is a convenience, not a lock-in. Set
`AGENT_BLACKBOX_HOME` to store sessions somewhere other than `~/.agent-blackbox`.

The full spec, including every event type and its payload shape, is in
[docs/format.md](docs/format.md).

## Sharing sessions

`export` packs `meta.json`, `events.jsonl`, and `terminal.cast` into a single gzipped
`.agentlog` file. `open` unpacks one back into the local store, where it replays like any session
you recorded yourself.

```bash
agent-blackbox export 01K1YQ7P8Z       # pack one session into a .agentlog file
agent-blackbox open watchdog.agentlog  # unpack someone else's back into your store
agent-blackbox ui                      # replay it exactly like your own
```

Session ids can be given as an unambiguous prefix, so `01K1YQ7P8Z` is enough. Attach the
`.agentlog` to an issue and a maintainer can watch the exact session that went wrong instead of
reading a paraphrase of it. Read [Privacy and security](#privacy-and-security) before you do.

## Privacy and security

The recorder is local-only by construction:

- **No telemetry, no accounts, no uploads.** The only network listener is the dashboard, and it
  binds `127.0.0.1` — nothing is exposed on your network.
- **Terminal input is never recorded.** Only output and resize events are written to the cast. A
  secret you typed that the terminal did not echo never reaches disk.
- **Your Claude Code config is untouched.** Hooks are passed per-invocation via `--settings`;
  the recorder does not modify `~/.claude/settings.json` or any project settings file.
- **Everything stays in one directory.** `~/.agent-blackbox` (or `AGENT_BLACKBOX_HOME`). Deleting a
  session directory deletes the recording.

What a recording *does* contain is whatever was on screen, plus tool inputs and outputs, your
prompts, and file diffs. If a command printed an API key, that key is in the cast. Treat
`.agentlog` files like application logs: review before sharing, and don't post one publicly without
looking at it first. Automatic secret redaction on export is on the roadmap and does not exist yet.

Full threat model, including exactly what is and is not captured:
[docs/security.md](docs/security.md).

## How it compares

|                          | Agent Black Box       | Terminal scrollback | asciinema alone | Claude Code transcripts | Screen recording |
| ------------------------ | --------------------- | ------------------- | --------------- | ----------------------- | ---------------- |
| Structured tool timeline | Yes                   | No                  | No              | Raw JSONL, no timeline  | No               |
| Terminal replay          | Yes                   | No                  | Yes             | No                      | Yes, as video    |
| Token / cost accounting  | Yes, per model        | No                  | No              | Raw usage fields        | No               |
| Shareable single file    | Yes, `.agentlog`      | Copy-paste          | Yes, `.cast`    | Machine-local paths     | Large video file |
| Works offline            | Yes                   | Yes                 | Yes             | Yes                     | Yes              |

asciinema is the closest neighbor, and Agent Black Box uses its format on purpose — the difference
is the other two channels layered on the same clock.

## Roadmap

Not built yet. Listed so you know where this is going:

- [ ] Fork and replay: rerun a session from any point with a changed instruction
- [ ] Adapters for coding agents other than Claude Code
- [ ] Secret redaction pass on export
- [ ] Full-text search across recorded sessions
- [ ] Session diffing

## Contributing

Bug reports, format feedback, and PRs are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
dev setup, the repo layout, and how to run the dashboard against a live recorder. Issues labeled
`good first issue` are scoped to be self-contained — a good place to start if you want one.

The monorepo is three packages:

| Package                     | Role                                        |
| --------------------------- | ------------------------------------------- |
| `@agent-blackbox/core`      | Session format, event schema, storage       |
| `@agent-blackbox/cli`       | Recorder, dashboard server, `.agentlog` I/O |
| `@agent-blackbox/dashboard` | React replay UI                             |

## License

[MIT](LICENSE) © Derek Martin
