# Demo fixture

A single hand-authored session store, so you can open the dashboard and see a
finished recording without recording one first.

```
fixtures/
  sessions/
    01JDEM0FAKESESS10N000000FX/
      meta.json       complete SessionMeta
      events.jsonl    49 events (prompts, tool calls, file changes, token usage)
      terminal.cast   asciinema v2 terminal recording
```

## View it

```sh
AGENT_BLACKBOX_HOME=$(pwd)/fixtures agent-blackbox ui
```

`SessionStore` treats `AGENT_BLACKBOX_HOME` as the store root and looks for
sessions under `<root>/sessions`, so pointing it at `fixtures/` is all it takes.
The same variable works with the other subcommands, for example:

```sh
AGENT_BLACKBOX_HOME=$(pwd)/fixtures agent-blackbox ls
```

## What is in it

Nine minutes of a fictional session that tracks down a flaky watchdog test in a
project called `circuitsim`: reproduce the flake with a repeated test run, fan a
subagent out to audit timer usage, inject a clock, then confirm the suite is
green. Two models appear (`claude-fable-5` on the main thread,
`claude-opus-5` for the subagent) with cache-aware token counts totalling about
one dollar of estimated spend.

Everything here is synthetic. The session id, the agent session UUID, the file
paths, the diffs, and the token counts were all written by hand; no real session
was recorded and no real project is described. Timestamps are fixed, so the
fixture renders identically on every machine.

`packages/core/test/fixture.test.ts` loads this directory through the real
`SessionStore`, which keeps the fixture honest against the session format.
