# Security and privacy model

agentrec records your development sessions. That is inherently sensitive, so this document
states plainly what is captured, what is not, where it goes, and what you should check before
sharing a recording.

For reporting a vulnerability, see [SECURITY.md](../SECURITY.md).

## Design posture

Three properties, enforced structurally rather than by configuration:

1. **Local only.** No accounts, no telemetry, no outbound network calls. Recording works fully
   offline.
2. **Output only, never input.** The cast writer has no code path for writing terminal input.
3. **Your Claude Code configuration is never modified.** Hooks are injected per-invocation.

None of these are toggles you can accidentally leave off.

## Trust boundaries

| Boundary                     | Assumption                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Your user account            | Trusted. Recordings are ordinary files readable by your user; anyone with your account or root can read them. |
| Other local processes        | **Partially trusted.** The dashboard listens on loopback with no authentication, so any process running as any user on the machine can read it while it is running. |
| The network                  | Untrusted, and unused. Nothing binds a routable interface.                                    |
| A `.agentlog` you receive    | **Untrusted data.** Opening one writes files and renders recorded content; treat it like a log file from a stranger. |
| A `.agentlog` you send       | Leaves your control permanently. Review it first.                                            |

## What is recorded

| Captured                    | Channel      | Detail                                                                                  |
| --------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Terminal **output**         | PTY          | Everything the wrapped `claude` process wrote to the screen, escape sequences included.  |
| Terminal dimensions         | PTY          | Initial size and every resize.                                                          |
| Your prompts                | hooks        | Full text of what you asked, verbatim.                                                  |
| Tool calls                  | hooks        | Tool name and its **complete input arguments** — commands, paths, patterns, payloads.   |
| Tool results                | hooks        | Tool output, including command stdout/stderr as the agent saw it.                        |
| File changes                | hooks        | Changed path, whether it was a create or an edit, and **the diff of the change**.        |
| Notifications, turn ends    | hooks        | Lifecycle markers.                                                                      |
| Assistant text              | transcript   | The model's prose replies.                                                              |
| Token usage                 | transcript   | Per-request counts and the model id. Numbers only.                                       |
| Session title               | transcript   | Claude Code's generated title, which summarizes your task.                               |
| Working directory           | meta         | Absolute path, which typically includes your username.                                  |
| Git branch                  | meta         | Branch name at start of recording.                                                      |
| Wrapped command             | meta         | The argv you invoked, including any flags you passed to `claude`.                        |

Concretely: **file contents appear in a recording** whenever the agent read or edited a file, and
**command output appears** whenever a command ran. That is the feature. It is also the risk.

## What is never recorded

| Not captured                     | Why                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Keystrokes / terminal input       | `CastWriter` emits only asciicast `o` (output) and `r` (resize) events. There is no input writer, and the recorder never emits `i` events. A password or token you typed that the terminal did not echo never touches disk. |
| Your process environment          | The recorder does not dump `process.env`. The asciicast header's optional `env` carries terminal descriptors (`TERM`, `SHELL`) per the asciicast convention — not your variables. |
| Secrets, as a category            | There is no secret store to read. API keys are captured only in the ordinary sense that *anything printed to the screen is captured*. |
| Files the agent never touched     | There is no filesystem scan. Only paths flowing through tool calls are recorded.                    |
| Anything after the session ends   | The recorder is a process wrapper. When `claude` exits, capture stops.                               |
| Anything from other sessions      | Each session is an isolated directory.                                                              |

The important caveat, stated directly: **"keystrokes are not recorded" is not the same as "secrets
are not recorded."** If you paste a key and the TUI echoes it, it is in the cast. If a script prints
`AWS_SECRET_ACCESS_KEY=…`, it is in the cast. If the agent `cat`s your `.env`, the contents are in
the tool output.

## Where data lives

```text
~/.agentrec/sessions/<ulid>/{meta.json, events.jsonl, terminal.cast}
```

- Override the root with `AGENTREC_HOME`. Nothing is written outside it.
- Files are written with your user's default permissions, like any file your shell creates. On a
  shared machine, review the mode of the directory yourself if that matters to you.
- There is no database, index, or cache elsewhere on disk. Deleting a session directory deletes the
  recording completely. Deleting `~/.agentrec` removes everything.
- There is no retention policy and no automatic pruning. Recordings persist until you remove them.

## Network posture

- **Recording makes no network calls.** The recorder only spawns a child process and writes files.
  (The wrapped `claude` talks to Anthropic, as it always does — that is unchanged, and unrelated.)
- **`agentrec ui` binds `127.0.0.1`**, not `0.0.0.0`. It is not reachable from your LAN, and
  no port-forwarding or tunnel is set up on your behalf.
- The dashboard is served from the same origin as its API. All routes are local reads: session list,
  session detail, events, raw cast, and a server-sent-events stream for live sessions.
- **The local server is unauthenticated.** Loopback binding is the entire access control. Any process
  on your machine can read your sessions through it while it is running, and any browser page could
  in principle probe a known local port. Stop the server when you are not using it, and prefer not
  to run it on a machine you share with untrusted users.
- There is no update check, crash reporter, or analytics beacon.

## How hook injection works

Claude Code can run an external command at lifecycle points. To capture structured events, the
recorder builds a hook configuration in memory and hands it to the child process using Claude Code's
`--settings` flag, pointing the hooks at `agentrec hook`.

Why this matters for security:

- **No settings file is read or written.** `~/.claude/settings.json`, `.claude/settings.json`, and
  `.claude/settings.local.json` are untouched. Your own hooks, permissions, and MCP configuration are
  not read, merged, overridden, or reordered by the recorder.
- **Nothing persists.** The injected configuration exists for the lifetime of that one child process.
  If the recorder crashes, there is no half-written config to clean up and no hook left behind that
  keeps recording.
- **Recording is opt-in per command.** A session is recorded because you typed
  `agentrec claude`. Running plain `claude` records nothing.
- **The hook receiver is a local process** invoked by Claude Code with a payload on stdin. It appends
  to the session log and does nothing else — no network, no shelling out to user-supplied strings.

## Before you share a `.agentlog`

An export is a faithful copy of everything above. There is **no redaction today**. Assume that
anything you saw on screen during the session is in the file.

Check for:

- **Credentials in command output** — `env`, `printenv`, cloud CLI logins, `docker login`, anything
  that echoes a token, connection string, or signed URL.
- **`.env` and secret files** the agent read or edited. Those contents are in tool outputs and diffs.
- **Proprietary source** in file diffs and read results. A session in a private repo exports that
  repo's code, in the shape of diffs.
- **Internal hostnames, ticket ids, customer names** in your prompts, in the generated session
  title, and in command output.
- **Local paths** in `cwd` and tool inputs, which usually contain your username and can reveal client
  or project names.
- **Git branch names**, which often encode ticket ids or unreleased feature names.

Practical workflow:

```bash
# Inspect before sending: metadata, prompts, and the tool calls that ran.
gunzip -c session.agentlog | jq '.meta'
gunzip -c session.agentlog | jq -r '.events[] | select(.type=="prompt") | .data.text'
gunzip -c session.agentlog | jq -r '.events[] | select(.type=="tool.start") | .data.name'

# Grep the whole bundle, including terminal output, for obvious secret shapes.
gunzip -c session.agentlog | grep -aiE 'api[_-]?key|secret|bearer |password|BEGIN [A-Z ]*PRIVATE KEY'
```

A clean grep is not proof of safety — it catches obvious patterns, not everything. For anything
sensitive, prefer recording a fresh, minimal reproduction over sanitizing a long session.

If your organization treats source code as confidential, treat `.agentlog` files as confidential
artifacts and keep them inside the same systems you would use for a support bundle or a heap dump.

## Opening a `.agentlog` you received

Importing writes files into your session store and replays recorded terminal output in the
dashboard. Two things to know:

- The bundle's **original session id** is used on import, and import refuses to overwrite an existing
  id unless overwriting is requested — a received file cannot silently replace one of your sessions.
- Replayed content is untrusted text containing arbitrary escape sequences. Review an unfamiliar
  bundle's `meta` and prompts with `jq` before replaying it, particularly if it came from someone you
  do not know.

To keep a received session out of your own store entirely, point the store elsewhere:

```bash
AGENTREC_HOME=/tmp/abb-review agentrec open theirs.agentlog
AGENTREC_HOME=/tmp/abb-review agentrec ui
```

## Known gaps

Honest list of what is not solved yet:

- **No redaction.** A redaction pass on export is on the roadmap. Until it ships, review is manual.
- **No encryption at rest.** Recordings are plain files; use full-disk encryption if you need it.
- **No authentication on the local server.** Loopback binding is the only boundary.
- **No integrity guarantee on `.agentlog`.** There is no signature or checksum, so a bundle can be
  edited after export. A received recording is evidence of what someone chose to send you, not proof
  of what happened.
- **Best-effort capture.** Recording is not transactional. A crash can truncate the final event, and
  capture failures are logged in-band as `recorder.error` events rather than aborting the session —
  so absence of an event is not proof that nothing happened.

## Related

- [SECURITY.md](../SECURITY.md) — reporting a vulnerability
- [Session format](format.md) — exactly which fields exist
- [Architecture](architecture.md) — how the three capture channels work
