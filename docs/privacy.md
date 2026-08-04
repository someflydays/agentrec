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

There is one capability that does not fit the observe-only shape of everything else: **forking
starts a new agent process.** It is never implicit, and it is the subject of
[its own section below](#the-ui-server-and-forking).

## Trust boundaries

| Boundary                     | Assumption                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Your user account            | Trusted. Recordings are ordinary files readable by your user; anyone with your account or root can read them. |
| Other local processes        | **Partially trusted.** The dashboard's read routes are unauthenticated, so any process on the machine can read your sessions through it while it is running — and can read the fork token from `/api/capabilities`. |
| A browser page on another origin | **Untrusted.** Rejected by the Origin/Host guard before any handler runs, and it cannot read the fork token. |
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
| Transcript line ids         | transcript   | The `uuid` of the Claude Code transcript line an event came from. Identifiers only.       |
| Working directory           | meta         | Absolute path, which typically includes your username.                                  |
| Git branch                  | meta         | Branch name at start of recording.                                                      |
| Wrapped command             | meta         | The argv you invoked, including any flags you passed to `claude`.                        |
| Fork lineage                | meta         | On a forked session only: the source session id and the event it was cut at.             |

Concretely: **file contents appear in a recording** whenever the agent read or edited a file, and
**command output appears** whenever a command ran. That is the feature. It is also the risk.

## What is never recorded

| Not captured                     | Why                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Keystrokes / terminal input       | `CastWriter` emits only asciicast `o` (output) and `r` (resize) events. There is no input writer, and the recorder never emits `i` events. A password or token you typed that the terminal did not echo never touches disk. |
| Your process environment          | The recorder does not dump `process.env`. It also writes no `env` block in the asciicast header at all: the format permits one and the parser accepts it, but no recorder path sets it. |
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
~/.agentrec/index.db
```

- Override the root with `AGENTREC_HOME`. Nothing is written outside it.
- Files are written with your user's default permissions, like any file your shell creates. On a
  shared machine, review the mode of the directory yourself if that matters to you.
- **`index.db` is a second on-disk copy of session text.** The search index holds prompts, assistant
  text, tool inputs and outputs, and file paths for every session in the store, alongside
  `index.db-journal` / `-wal` / `-shm` files SQLite may leave beside it. It is a rebuildable cache,
  so deleting it is always safe — but treat it as being as sensitive as the recordings themselves.
- **Deleting a session directory deletes the recording, but not its index rows.** They are dropped on
  the next sync, which happens the next time you search. Delete `index.db` if you want the text gone
  immediately. Deleting `~/.agentrec` removes everything.
- There is no retention policy and no automatic pruning. Recordings persist until you remove them.

## Network posture

- **Recording makes no outbound network calls**, and nothing leaves your machine. It does open one
  loopback listener: hooks run as short-lived children of the agent, not of the recorder, so the
  recorder starts an ingest server on `127.0.0.1` with an ephemeral port and hands the URL and a
  random 32-byte bearer token to the child through the environment. It accepts `POST /events` and
  nothing else, rejects a request without the token with 401, and dies with the recording. (The
  wrapped `claude` talks to Anthropic, as it always does — that is unchanged, and unrelated.)
- **`agentrec ui` binds `127.0.0.1`**, not `0.0.0.0`. It is not reachable from your LAN, and
  no port-forwarding or tunnel is set up on your behalf.
- The dashboard is served from the same origin as its API. The read routes are the session list,
  session detail, events, the raw cast, an SSE stream for live sessions, search, diff, fork points,
  and a capabilities probe. The one route that is not a read is the fork POST, described below.
- **The local read routes are unauthenticated.** Loopback binding plus the Origin/Host guard is the
  entire access control: it stops a browser page on another origin, not another process running as
  you. Stop the server when you are not using it, and prefer not to run it on a machine you share
  with untrusted users.
- There is no update check, crash reporter, or analytics beacon.

## How hook injection works

Claude Code can run an external command at lifecycle points. To capture structured events, the
recorder builds a hook configuration in memory and hands it to the child process using Claude Code's
`--settings` flag, pointing every hook at the CLI's own hidden `_hook` subcommand.

Why this matters for security:

- **No settings file is read or written.** `~/.claude/settings.json`, `.claude/settings.json`, and
  `.claude/settings.local.json` are untouched. Your own hooks, permissions, and MCP configuration are
  not read, merged, overridden, or reordered by the recorder.
- **Nothing persists.** The injected configuration exists for the lifetime of that one child process.
  If the recorder crashes, there is no half-written config to clean up and no hook left behind that
  keeps recording.
- **Recording is opt-in per command.** A session is recorded because you typed
  `agentrec claude`. Running plain `claude` records nothing.
- **The hook command is fixed, not composed.** It is the current Node binary and CLI entry point,
  both JSON-quoted, plus the literal `_hook` — no user-supplied string is interpolated into it.
- **The hook receiver does one thing.** `agentrec _hook` reads the payload on stdin and POSTs it to
  the recorder's loopback ingest URL with the bearer token it inherited. It writes nothing to disk,
  makes no other request, never prints, and never exits non-zero — a hook that misbehaves would
  degrade the session it is observing. The recorder, not the hook, appends to the log.

## The `ui` server and forking

Recording only ever observes. **Forking executes**: it spawns a real agent process that spends
tokens, runs tools, and writes to your filesystem, in the *recorded session's* working directory
rather than wherever you started the dashboard. And unlike everything else in agentrec, it can be
triggered from a browser page. Three independent gates stand in front of it.

**1. The route only exists with `--allow-fork`.** `agentrec ui` mounts no fork handler by default;
`POST /api/sessions/<id>/fork` then answers 404, the same as any unknown API route. `--allow-fork`
is the only thing that mounts it, and the server prints a warning line at startup when it is on.
With it off, the dashboard still shows the fork panel, still resolves the fork point, and offers the
equivalent `agentrec fork` command to copy — it just cannot run anything.

**2. Every request must come from this exact server.** Loopback binding keeps the store off the
network but not away from the browser: any page you have open can send requests to `127.0.0.1`, and
a hostname that resolves there (DNS rebinding) arrives carrying the attacker's own `Host`. So
`crossOriginRefusal` runs before any handler, on every request including static assets, and answers
403 unless:

- an `Origin` header, if present, parses to a loopback host (`127.0.0.1`, `localhost`, `[::1]`) on
  this server's own port — a same-origin GET normally sends no `Origin` at all, a cross-origin one
  always does; and
- a `Host` header, if present, names one of those same loopback hosts.

**3. The fork POST additionally needs a per-process token.** A 32-byte random token is generated
once per server run and delivered two ways to the page that legitimately loaded from it: as a
`<meta name="agentrec-token">` tag injected into the served `index.html`, and from
`GET /api/capabilities`. The fork request must echo it in the `X-Agentrec-Token` header, compared
with a constant-time equality check. It is no secret from you or from other processes on your
machine — it is a secret from *other origins*, which cannot read a same-origin response of this
server.

Past the gates, the request still has to be well formed: `POST` only (405), `application/json`
(415), body under 1 MiB (413), a `seq` that is one of the session's fork points (400), and one fork
running per server at a time (409).

Two further properties of the execution path:

- **The prompt is passed as an argv element, never through a shell.** The browser's text goes
  straight into `spawn`'s argument array; there is no shell anywhere in that path to interpret it.
- **The transcript is only ever read.** A fork writes a new truncated transcript under a fresh id
  with an exclusive-create flag, so it cannot clobber an existing Claude Code session, and it refuses
  to run at all against a Claude Code version or transcript shape it does not recognize.

Forking does not rewind your working tree. It replays the conversation, not the files on disk.

## Redacting an export

`agentrec export --redact` runs a scrubbing pass while packing the bundle. What to expect:

- **It applies only to the exported copy.** The stored session is never modified, so a bad redaction
  costs you an export, not a recording.
- **What it covers.** Prompts, assistant text, session titles, notifications, the string leaves of
  tool inputs, tool outputs, file-change diffs, `meta.title`, `meta.command`, `meta.cwd`, and the
  terminal cast — both its output payloads and its header's `title` and `env`. Matches are replaced
  with `[REDACTED:<label>]`, and `--redact` prints a count per label so you can see what fired.
- **How it matches.** A registry of named credential shapes — PEM private keys, JWTs,
  Anthropic/OpenAI/Google/Slack/GitHub keys, AWS access key ids and secret keys, `Authorization`
  headers, and `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=`-style assignments — plus a Shannon-entropy
  heuristic for high-entropy strings that no named pattern caught.
- **The entropy pass is deliberately conservative.** It skips UUIDs, ULIDs, all-hex strings,
  integrity hashes, Claude Code `req_`/`msg_`/`toolu_` ids, anything containing a path or URL
  character, underscore-separated identifiers, and base64 that decodes to readable text — because
  recorded sessions are full of all of those. A false positive silently corrupts a recording someone
  is about to share and cannot be undone from the `.agentlog`; a miss is still catchable by reading
  the export. It errs toward leaving text alone.

The consequence is worth stating plainly: **redaction is a safety net, not a guarantee.** It targets
credentials, not confidentiality — source code in diffs, internal hostnames, ticket ids, customer
names, your username in paths, and `meta.gitBranch` all pass through untouched, and a secret that
looks like ordinary text is not detectable at all. Read the bundle before you send it.

## Before you share a `.agentlog`

An export is a faithful copy of everything above, minus whatever `--redact` happened to catch.
Assume that anything you saw on screen during the session is in the file.

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
agentrec export 01K1YQ7P8Z --redact -o review.agentlog
```

```bash
gunzip -c review.agentlog | jq '.meta'
gunzip -c review.agentlog | jq -r '.events[] | select(.type=="prompt") | .data.text'
gunzip -c review.agentlog | jq -r '.events[] | select(.type=="tool.start") | .data.name'
gunzip -c review.agentlog | grep -aiE 'api[_-]?key|secret|bearer |password|BEGIN [A-Z ]*PRIVATE KEY'
```

The first three commands inspect metadata, prompts, and the tool calls that ran; the last greps the
whole bundle, terminal output included, for obvious secret shapes.

A clean grep is not proof of safety — it catches obvious patterns, not everything. For anything
sensitive, prefer recording a fresh, minimal reproduction over sanitizing a long session.

If your organization treats source code as confidential, treat `.agentlog` files as confidential
artifacts and keep them inside the same systems you would use for a support bundle or a heap dump.

## Opening a `.agentlog` you received

Importing writes files into your session store and replays recorded terminal output in the
dashboard. Three things to know:

- The bundle's **original session id** is used on import, and import refuses to overwrite an existing
  id unless overwriting is requested — a received file cannot silently replace one of your sessions.
- That id is validated before it becomes a directory name: letters, digits, `_` and `-` only, no
  separators or dots, at most 64 characters. A bundle cannot write outside your session store.
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

- **Redaction is heuristic.** `--redact` is tuned to avoid false positives, so it misses things by
  construction, and it does not attempt to remove non-credential confidential content at all. Manual
  review before sharing is still the actual control.
- **No encryption at rest.** Recordings are plain files; use full-disk encryption if you need it.
- **No authentication against local processes.** The Origin/Host guard defends against browser pages
  on other origins, not against anything running as you. Any local process can read your sessions
  through the dashboard while it is running, and can read the fork token from `/api/capabilities` —
  so on a server started with `--allow-fork`, it can also start a fork.
- **The search index outlives deleted sessions** until the next sync rewrites it.
- **No integrity guarantee on `.agentlog`.** There is no signature or checksum, so a bundle can be
  edited after export. A received recording is evidence of what someone chose to send you, not proof
  of what happened.
- **Best-effort capture.** Recording is not transactional. A crash can truncate the final event, and
  capture failures are logged in-band as `recorder.error` events rather than aborting the session —
  so absence of an event is not proof that nothing happened.
- **Fork depends on Claude Code internals.** It is gated (`--experimental` on the CLI, `--allow-fork`
  on the server) and refuses to run against an unrecognized version or transcript shape, but that is
  a guard against corruption, not a stability promise.

## Related

- [SECURITY.md](../SECURITY.md) — reporting a vulnerability
- [Session format](format.md) — exactly which fields exist
- [Architecture](architecture.md) — how the three capture channels work
