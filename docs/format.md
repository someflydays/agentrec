# Session format

A recorded session is a directory. Nothing about reading one requires this project's code — the
files are JSON, JSONL, and a standard asciicast.

```text
~/.agentrec/                          # or $AGENTREC_HOME
├── index.db                          # search index: a cache, never source data
└── sessions/
    └── 01K1YQ7P8ZC3M4N5R6S7T8V9W0/   # ULID, sortable by start time
        ├── meta.json                 # session identity and outcome
        ├── events.jsonl              # append-only structured event log
        └── terminal.cast             # asciinema v2 terminal recording
```

Current `formatVersion` is **1**.

The three files inside a session directory are the format. `index.db` at the store root is derived
from them and is described under [index.db](#indexdb) — deleting it is always safe.

## meta.json

A single JSON object, pretty-printed. Mutable during recording: the title arrives when Claude Code
generates it, and `endedAt` / `exitCode` are filled in on exit. It is rewritten atomically
(write-temp-then-rename), so a reader never sees a partial file.

| Field             | Type                                | Required | Notes                                                                |
| ----------------- | ----------------------------------- | -------- | -------------------------------------------------------------------- |
| `formatVersion`   | `1`                                 | yes      | Literal. Bumped only on a breaking change.                           |
| `id`              | `string`                            | yes      | Recorder-assigned ULID. Matches the directory name.                  |
| `agent`           | `"claude-code"`                     | yes      | The only value today; the field exists so other agents can be added. |
| `command`         | `string[]`                          | yes      | argv of the wrapped process, e.g. `["claude", "--continue"]`.         |
| `cwd`             | `string`                            | yes      | Working directory the recording started in.                          |
| `startedAt`       | `string`                            | yes      | ISO 8601. **The origin for every timestamp in the session.**          |
| `endedAt`         | `string`                            | no       | ISO 8601. Absent while the session is live or if the recorder died.   |
| `exitCode`        | `number \| null`                    | no       | Exit code of the wrapped process. `null` when it was signalled.       |
| `title`           | `string`                            | no       | Claude Code's generated session title, when one was produced.         |
| `agentSessionId`  | `string`                            | no       | The wrapped agent's own session id (Claude Code session UUID).        |
| `gitBranch`       | `string`                            | no       | Branch checked out when recording started.                           |
| `recorderVersion` | `string`                            | no       | Version of the CLI that produced the session.                        |
| `forkedFrom`      | `{ sessionId: string, seq: number }` | no       | Present only on a session created by a fork. See below.              |

A session is considered **live** when `endedAt` is absent.

`forkedFrom` names the recording this session was forked from (`sessionId`) and the event within it
the conversation was cut at (`seq`). It is written by both fork paths — `agentrec fork` and the
dashboard's fork route — and never by an ordinary recording. It is an addition to the format, not a
change to it: readers that do not know the field ignore it.

The `session.start` event carries `SessionMeta` as it stood when the session was created, so fields
that arrive later (`title`, `endedAt`, `exitCode`) are usually absent there and present in
`meta.json`. When the two disagree, `meta.json` is the later state.

## events.jsonl

One JSON object per line, appended in order, never rewritten. Every line shares the same envelope:

```json
{ "seq": 0, "t": 0, "type": "session.start", "data": { "meta": { "…": "…" } } }
```

| Field  | Type     | Notes                                                                |
| ------ | -------- | -------------------------------------------------------------------- |
| `seq`  | `number` | Monotonic per-session sequence number, starting at `0`. No gaps.     |
| `t`    | `number` | Milliseconds since `meta.startedAt`. Never negative.                 |
| `type` | `string` | One of the types below.                                              |
| `data` | `object` | Type-specific payload. Always an object, possibly empty.             |

A single writer assigns `seq`, incrementing once per appended event, so the file as written has no
gaps. A reader that skips an unparseable line (see [tolerant reading](#tolerant-reading)) will
observe one.

The first line of every file is a `session.start` event carrying the full `SessionMeta`, which makes
the log self-describing on its own.

### Event types

| `type`            | `data` shape                                                                                 | Emitted by |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------- |
| `session.start`   | `{ meta: SessionMeta }`                                                                      | recorder   |
| `session.end`     | `{ exitCode: number \| null }`                                                                | recorder   |
| `session.title`   | `{ title: string }`                                                                          | transcript |
| `prompt`          | `{ text: string }`                                                                           | hooks      |
| `tool.start`      | `{ name: string, input: unknown, toolUseId?: string }`                                        | hooks      |
| `tool.end`        | `{ name: string, ok: boolean, output?: string, toolUseId?: string }`                          | hooks      |
| `assistant.text`  | `{ text: string, model?: string, requestId?: string, transcriptUuid?: string }`               | transcript |
| `usage`           | `{ model: string, requestId: string, usage: TokenUsage, transcriptUuid?: string }`            | transcript |
| `file.change`     | `{ path: string, kind: "create" \| "edit", diff?: string, toolUseId?: string }`                | hooks      |
| `notification`    | `{ message: string }`                                                                        | hooks      |
| `turn.end`        | `{}`                                                                                         | hooks      |
| `subagent.end`    | `{}`                                                                                         | hooks      |
| `terminal.resize` | `{ cols: number, rows: number }`                                                             | recorder   |
| `recorder.error`  | `{ source: string, message: string }`                                                        | recorder   |

Notes on individual types:

- **`tool.start.input`** is the tool's arguments as the agent supplied them, unmodified and
  unvalidated — hence `unknown`. Its shape depends entirely on the tool.
- **`toolUseId`** correlates a `tool.start`, its `tool.end`, and any `file.change` it caused. It is
  optional because not every source path supplies one; do not assume it is present.
- **`tool.end.ok`** records whether the tool succeeded. Claude Code fires `PostToolUse` only on
  success and a separate `PostToolUseFailure` on failure, so `ok` is `true` for a `PostToolUse` and
  `false` for a `PostToolUseFailure`. (No built-in tool emits a `tool_response.success` field in
  2.1.221; a `success: false` from an MCP tool is still honored if one appears.)
- **`tool.end.output`** on success is the hook's `tool_response` serialized as JSON, cut to 16,384
  characters with a trailing `…[truncated]`; on failure it is the payload's `error` string, which is
  already human-readable prose. It is absent when neither was present.
- **`file.change`** is derived from successful `Edit` and `Write` tool calls only; a failed write
  produces none. `diff` is unified-*shaped* — the hook payload carries the replaced text but not its
  position, so the hunk header is nominal. It is cut to 204,800 characters the same way.
- **`assistant.text`** and **`usage`** carry `transcriptUuid` when the capture path knew it: the
  `uuid` of the agent transcript line the event was read from. It is what lets a fork cut the
  conversation at exactly that line instead of guessing by timestamp. Optional, and absent from
  recordings made before it existed.
- **`usage`** appears exactly once per API request. See [deduplication](#token-usage-deduplication).
- **`turn.end`** marks a turn boundary — the natural unit for grouping a timeline.
- **`recorder.error`** is a non-fatal problem *inside the recorder*, kept in-band so a session that
  partially failed to capture says so instead of quietly missing events. `source` names the failing
  part of the recorder (`ingest`, `pty` and `spawn` are written today); treat it as an open set.

### TokenUsage

Used by the `usage` event. All fields are required, non-negative integers.

| Field                         | Meaning                                       |
| ----------------------------- | --------------------------------------------- |
| `inputTokens`                 | Uncached input tokens.                        |
| `outputTokens`                | Generated tokens.                             |
| `cacheReadInputTokens`        | Tokens served from prompt cache.              |
| `cacheCreation5mInputTokens`  | Tokens written to cache, 5-minute TTL.        |
| `cacheCreation1hInputTokens`  | Tokens written to cache, 1-hour TTL.          |

### Token usage deduplication

One API response occupies several `assistant` lines in the Claude Code transcript — one per content
block — and each line repeats the *same cumulative* usage object under the *same* `requestId`.
Summing per line overcounts spend by the number of content blocks.

The recorder therefore emits at most one `usage` event per `requestId`, and every `usage` event
carries that `requestId`. **Consumers must not sum usage across events sharing a `requestId`**; if
you see a duplicate, treat it as one observation.

When the transcript reports `cache_creation_input_tokens` without a TTL breakdown, the full amount
is recorded as `cacheCreation5mInputTokens` — the cheaper tier — so estimates lean low.

### Tolerant reading

Readers must skip lines that fail to parse instead of rejecting the file. A recording killed
mid-write leaves at most one torn final line, and losing one event is preferable to losing the
session. The reference implementation (`SessionStore.readEvents`) does exactly this.

## terminal.cast

An [asciinema v2](https://docs.asciinema.org/manual/asciicast/v2/) file (asciicast), unmodified.
Line 1 is a JSON header; every subsequent line is a JSON array.

| Header field | Type                     | Required | Written by the recorder                                |
| ------------ | ------------------------ | -------- | ------------------------------------------------------ |
| `version`    | `2`                      | yes      | Always. Readers reject anything else.                  |
| `width`      | `number`                 | yes      | Terminal columns at start.                             |
| `height`     | `number`                 | yes      | Terminal rows at start.                                |
| `timestamp`  | `number`                 | no       | Always. Unix seconds.                                  |
| `title`      | `string`                 | no       | Always: the recorded command, joined by spaces.        |
| `env`        | `Record<string, string>` | no       | **Never.** Permitted by the format; parsed if present. |

Each event line is `[t, code, data]`:

- `t` — seconds since recording start, six decimal places. Same origin as `meta.startedAt`, so cast
  time in seconds and event `t` in milliseconds describe the same clock.
- `code` — `"o"` for output, `"r"` for resize. Resize `data` is `"<cols>x<rows>"`, e.g. `"120x40"`.
- `data` — a JSON string. For `"o"`, raw terminal output including escape sequences.

```text
{"version":2,"width":120,"height":40,"timestamp":1785000000,"title":"claude"}
[0.418000, "o", "[2J[H"]
[1.902431, "o", "> add a watchdog timer to the poller\r\n"]
[9.115200, "r", "132x44"]
```

**The recorder never writes `i` events.** The asciicast spec allows `i` (input) and `m` (marker);
input capture is deliberately not implemented, so keystrokes cannot appear in a cast. Readers should
still tolerate `i` and `m` lines, since a cast may have come from elsewhere.

Because this is a plain asciicast, `asciinema play terminal.cast` works, as does `agg` for GIF
conversion and the asciinema player for embedding.

## index.db

A SQLite database at the **store root**, not inside a session directory: `<store>/index.db`. It
holds the FTS5 full-text index that backs `agentrec search` and the dashboard's search palette.

It is a **rebuildable cache, not source data.** Every row in it is derived from an `events.jsonl`
that is still on disk, and the index is rebuilt from those files whenever it is missing, empty, or
unreadable. Deleting `index.db` — along with any `index.db-journal`, `index.db-wal` and
`index.db-shm` beside it — is always safe and costs only the next reindex. It is gitignored for the
same reason: nothing about a recording is lost by not having it.

Consequences worth knowing:

- Its schema is versioned separately (`SEARCH_SCHEMA_VERSION`, currently 1) and carries no
  `formatVersion`. A schema change drops and recreates the tables rather than migrating.
- It contains session text — prompts, assistant text, tool inputs and outputs, file paths — so it is
  as sensitive as the recordings it indexes.
- It is never packed into a `.agentlog`, and importing one does not write to it. The next sync picks
  the imported session up.

## .agentlog

A whole session as one file: gzip of a single UTF-8 JSON object.

| Field     | Type              | Notes                                                        |
| --------- | ----------------- | ------------------------------------------------------------ |
| `format`  | `"agentlog"`      | Magic value. Readers reject anything else.                   |
| `version` | `1`               | Bundle container version, independent of `formatVersion`.     |
| `meta`    | `SessionMeta`     | Verbatim from `meta.json`.                                    |
| `events`  | `SessionEvent[]`  | Every parsed line of `events.jsonl`, in order.                |
| `cast`    | `string \| null`  | Full text of `terminal.cast`, or `null` if none was recorded. |

```json
{ "format": "agentlog", "version": 1, "meta": {}, "events": [], "cast": null }
```

Unpacking rejects, in order: data that does not gunzip, a `format` that is not `"agentlog"`, and any
`version` other than `1`.

Importing writes the bundle back out to the standard directory layout under the session's original
id. Two rules apply, because a bundle is untrusted input:

- **The id is validated before it becomes a directory name.** It must match
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` — no separators, no dots, no leading `-`, at most 64
  characters. Anything else is refused rather than sanitized, so a bundle cannot write outside the
  session store.
- **Import is non-destructive by default.** An id that already exists is an error unless the caller
  opts into overwriting.

Inspect one without this tool:

```bash
gunzip -c session.agentlog | jq '.meta'
```

## Compatibility policy

- **`formatVersion` bumps only on a breaking change** — a field removed, a field's type changed, or
  an existing event type's `data` shape changed incompatibly. Readers should refuse a
  `formatVersion` they do not know. It is currently `1`, and has never been bumped.
- **Adding a new event type is not breaking.** Readers **must ignore unknown `type` values** rather
  than erroring. Every reducer in this repo has a default-skip branch for exactly this reason.
- **Adding a new optional field is not breaking, and does not bump `formatVersion`.**
  `assistant.text.transcriptUuid`, `usage.transcriptUuid` and `meta.forkedFrom` were all added this
  way: recordings written before them are still valid `formatVersion` 1 sessions, and a reader that
  ignores them behaves exactly as it did before. Treat absent optional fields as absent, never as a
  default value that implies something.
- **Never assume `data` is exhaustive.** New optional keys may appear within an existing event's
  `data`.
- **`.agentlog` `version` moves independently** of `formatVersion`; the bundle container and the
  session format are versioned separately.
- Unparseable lines are skipped, not fatal, in both `events.jsonl` and `terminal.cast`.

## Related

- [Architecture](architecture.md) — why the format is shaped this way
- [Security and privacy model](privacy.md) — what a recording can contain
