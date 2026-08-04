# Roadmap

Where agentrec is going, in order, with enough design detail that each item can be picked up and
built. Tracked as [issues](https://github.com/someflydays/agentrec/issues) grouped into milestones;
this document is the narrative version.

Three principles constrain everything below:

- **Local-first, forever.** No telemetry, no accounts, no server dependency. Features that need a
  network (sharing, sync) happen through files the user moves themselves.
- **The format is the product.** `meta.json` + `events.jsonl` + `terminal.cast` stay stable and
  documented ([format.md](format.md)); readers must ignore unknown event types, and `formatVersion`
  only bumps on breaking changes.
- **Recording must never degrade the session being recorded.** Hooks stay fire-and-forget, capture
  failures degrade to fewer channels rather than broken sessions, and the recorder adds no
  perceptible latency.

## v0.2 — Fork and replay (experimental)

Rerun a session from any point with a changed instruction: click a timeline event, edit the prompt
that followed it, and launch a new session that begins from exactly that state of the conversation.

Design sketch:

- Claude Code persists the full conversation as a transcript JSONL and can resume any session with
  `claude --resume <session-id> --fork-session`. Forking from event N means: copy the original
  transcript truncated at the corresponding transcript line into a new session file under
  `~/.claude/projects/<slug>/`, then launch `claude --resume <new-id> --fork-session` wrapped in
  the recorder.
- The recorder already knows the transcript path (SessionStart hook) and the mapping from events to
  transcript lines is recoverable by timestamp and requestId; recording the transcript line offset
  on `usage`/`assistant.text` events at capture time would make the cut exact.
- New meta fields: `forkedFrom: { sessionId, seq }` so the dashboard can render lineage.
- CLI: `agentrec fork <session> --at <seq>`; dashboard: a "fork from here" action on timeline rows.

Honest caveats: this leans on Claude Code transcript internals that are not a public contract, so
the feature ships behind an `--experimental` flag with a version check, and degrades to a clear
error rather than a corrupted session when the format shifts. Filesystem state is *not* rewound —
forking replays the conversation, not the working tree; pairing with `git stash`/worktrees is the
user's call (documented, not automated, in v0.2).

## v0.2 — Redaction pass on export

`.agentlog` files get shared; screens contain secrets. `agentrec export --redact` runs a scrubbing
pass over every channel before packing: terminal cast output, tool inputs/outputs, prompts,
assistant text, and diffs.

Design sketch: a pattern registry (default: common credential shapes — AWS/GitHub/Anthropic/OpenAI
key prefixes, `Bearer` headers, PEM blocks, `.env`-style assignments) plus a high-entropy-string
heuristic, replacing matches with `[REDACTED:<label>]`. Patterns are pluggable via
`~/.agentrec/redact.json`. Redaction is destructive by design and only ever applied to the exported
copy, never the stored session. `--redact` prints a summary of what was replaced so the user can
audit before sharing.

## v0.3 — Full-text search

`agentrec search <query>` and a dashboard search box, across prompts, assistant text, tool inputs
and outputs, and file paths, returning sessions and the matching events with seq-deep links into
the replay.

Design sketch: Node 22.13+ ships `node:sqlite`, so an FTS5 index at `~/.agentrec/index.db` costs no
native dependency. The index is a rebuildable cache over the JSONL files (source of truth stays
plain text); `agentrec ui` and `search` update it incrementally by mtime. Dashboard results jump
straight to the event in the timeline with the terminal seeked to that moment.

## v0.3 — Session diffing

Compare two sessions side by side: same task attempted twice, before/after a prompt change, or two
model choices. Align on prompts and tool-call sequences, then surface what differed — files
touched, commands run, retries, token/cost totals, wall-clock duration.

Design sketch: alignment is heuristic (prompt text similarity, then tool-name sequence alignment),
rendered as a two-column timeline with divergence markers. Ships CLI-first
(`agentrec diff <a> <b>` with a summary table) to validate the alignment before investing in the
two-column UI.

## v0.4 — Adapters for other coding agents

The PTY and cast layers are agent-agnostic today; only hooks and transcript tailing are
Claude-Code-specific. An adapter interface makes that explicit:

```ts
interface AgentAdapter {
  detect(command: string[]): boolean;
  injectCapture?(argv: string[], env: NodeJS.ProcessEnv, ingest: IngestHandle): string[];
  attachTranscript?(hint: SessionStartInfo, emit: (obs: Observation) => void): Tailer | null;
}
```

Every command already records at the PTY tier (cast only); adapters add the structured tiers where
the agent exposes them. First targets, chosen by what they expose: Codex CLI and Gemini CLI
(session logs), opencode (event stream). `meta.agent` widens from `"claude-code"` to a string with
a registry — an additive format change.

## Continuous — hardening

Known gaps carried from v0.1.0 reviews, tracked as individual issues:

| Area | Gap |
| --- | --- |
| Dashboard | Timeline renders every row (no virtualization); seeking rewrites the whole output prefix |
| Dashboard | SSE can miss an event written between the initial fetch and stream subscribe (needs `since-seq`) |
| Server | Rereads full `events.jsonl` per request; session list re-summarizes on every poll |
| Recorder | `tool_use_id` correlation and `tool_response.success` are conventions, not verified contracts |
| Recorder | A user-supplied `--settings` in the wrapped command would collide with hook injection |
| Platform | Windows (ConPTY, signal forwarding) untested and unsupported |
| Release | No npm publish pipeline yet (provenance, version sync across the workspace) |

## Non-goals

- **Hosted anything.** No agentrec cloud, no upload endpoint. Sharing is a file.
- **Modifying the recorded agent.** agentrec observes; it never rewrites prompts, injects context,
  or filters what the agent sees.
- **Being an evaluation framework.** Recordings are evidence others can build evals on; scoring and
  benchmarking live outside this repo.
