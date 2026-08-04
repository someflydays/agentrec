# @agentrec/core

The session format and storage layer for [agentrec](https://github.com/someflydays/agentrec), a
flight recorder for Claude Code sessions.

This package defines the on-disk contract the rest of agentrec builds on: the typed event schema,
the append-only session store, asciinema-compatible terminal casts, portable `.agentlog` bundles,
the full-text search index, session diffing, model pricing and cost estimation, and the dashboard
API types. It is consumed by the `agentrec` CLI and dashboard; most people want the
[`agentrec`](https://www.npmjs.com/package/agentrec) package, not this one directly.

A browser-safe entry point (`@agentrec/core/browser`) exposes the pure data types and helpers with
no Node.js dependencies.

The format is documented in [docs/format.md](https://github.com/someflydays/agentrec/blob/main/docs/format.md).

MIT licensed.
