# agentrec

Flight recorder for Claude Code sessions: record, replay, and share exactly what your coding agent
did.

`agentrec claude` wraps the real `claude` CLI in a pseudoterminal and records the whole session
locally on three synchronized channels — the terminal exactly as you saw it, every tool call with
its inputs and outputs, and per-request token usage. `agentrec ui` replays it in a local dashboard
with a scrubbable timeline; `agentrec export` packs a session into one portable `.agentlog` file.

```bash
npm install -g agentrec   # Node >= 22.13
agentrec claude           # record — claude behaves exactly as it always does
agentrec ui               # replay in a local dashboard on 127.0.0.1
```

Everything stays on your machine: no telemetry, no network calls, the dashboard binds to loopback,
and terminal input is never recorded. See the [project README](https://github.com/someflydays/agentrec#readme)
for the full command set, the session format, and the privacy model.

MIT licensed.
