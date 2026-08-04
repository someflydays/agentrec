# @agentrec/dashboard

The local replay dashboard for [agentrec](https://github.com/someflydays/agentrec), a flight
recorder for Claude Code sessions.

This package ships the built single-page app that `agentrec ui` serves from `127.0.0.1`: a session
list, an event timeline synced to a terminal replay (play, pause, speed, scrub), file-change diffs,
per-model token and cost breakdowns, full-text search, session diffing, and fork-from-timeline. It
is served by the [`agentrec`](https://www.npmjs.com/package/agentrec) CLI and is not meant to be
installed on its own.

MIT licensed.
