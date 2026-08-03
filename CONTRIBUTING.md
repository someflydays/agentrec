# Contributing

Thanks for looking. Bug reports, format feedback, and pull requests are all welcome.

## Prerequisites

- **Node >= 20.19.** The repo pins `22` in `.node-version`; CI runs 20 and 22.
- **pnpm.** The version is pinned by `packageManager` in the root `package.json`. Easiest path:

  ```bash
  corepack enable
  ```

## Dev setup

```bash
pnpm install
pnpm -r build      # core and dashboard must be built before the CLI can run
```

Then run the CLI straight out of the workspace:

```bash
node packages/cli/bin/agentrec.js ls
node packages/cli/bin/agentrec.js ui
```

An alias saves a lot of typing while you work:

```bash
alias abbdev="node $(pwd)/packages/cli/bin/agentrec.js"
```

## Commands

Root scripts run across every package:

| Command            | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `pnpm -r build`    | Build all packages                                  |
| `pnpm -r typecheck`| `tsc --noEmit` in every package                     |
| `pnpm -r test`     | Vitest, once, in every package                      |
| `pnpm lint`        | `biome check .` — formatting and lint, read-only    |
| `pnpm lint:fix`    | `biome check --write .` — fixes what it can         |

Scope to one package while iterating:

| Command                                              | What it does                    |
| ---------------------------------------------------- | ------------------------------- |
| `pnpm --filter @agentrec/core build`           | Build core (tsup)               |
| `pnpm --filter @agentrec/core test`            | Core tests once                 |
| `pnpm --filter @agentrec/core exec vitest`     | Core tests in watch mode        |
| `pnpm --filter agentrec typecheck`        | Typecheck the CLI               |
| `pnpm --filter @agentrec/dashboard build`      | Build the dashboard (vite)      |

Formatting is Biome's job, not yours: 100-column lines, two-space indent, double quotes,
semicolons, trailing commas. Run `pnpm lint:fix` before pushing and don't hand-tune style.

## Repo layout

| Path                            | Contents                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `packages/core/`                | `@agentrec/core` — event schema, session storage, asciicast read/write, pricing, summaries, HTTP API contract |
| `packages/core/src/types.ts`    | The event schema. Changing this changes the recorded format.                   |
| `packages/core/src/browser.ts`  | Browser-safe entry point. Must stay free of `node:` imports.                   |
| `packages/cli/`                 | `agentrec` — recorder, hook receiver, dashboard server, export/import |
| `packages/cli/src/commands/`    | One file per subcommand, each exporting a `register*Command(program)`           |
| `packages/dashboard/`           | `@agentrec/dashboard` — React + xterm.js replay UI                       |
| `docs/`                         | Architecture, format spec, security model                                      |
| `fixtures/sessions/`            | Recorded sessions used for development. Excluded from lint and formatting so the data stays byte-exact. |

Two structural rules worth knowing before you start:

1. **`packages/core/src/browser.ts` must not import anything from `node:`.** The dashboard bundles
   it. Filesystem and zlib code belongs in the Node-only entry point.
2. **The CLI depends on the dashboard's built output.** If the UI renders stale, you forgot
   `pnpm --filter @agentrec/dashboard build`.

## Running the dashboard in dev mode

Two processes. The CLI serves the API and reads real sessions; Vite serves the UI with hot reload
and proxies `/api` to the CLI (see `packages/dashboard/vite.config.ts`).

```bash
# Terminal 1 — API only, on the port the Vite proxy expects
node packages/cli/bin/agentrec.js ui --port 4040 --no-open

# Terminal 2 — Vite dev server, hot reload
pnpm --filter @agentrec/dashboard dev
```

Open the URL Vite prints, not port 4040. The proxy is hardcoded to `127.0.0.1:4040`, so use exactly
that port in terminal 1.

### Developing against fixed data

`AGENTREC_HOME` relocates the session store, which is the easiest way to work against a stable
set of sessions instead of whatever you happen to have recorded:

```bash
AGENTREC_HOME=$(pwd)/fixtures node packages/cli/bin/agentrec.js ui --port 4040 --no-open
```

That reads `fixtures/sessions/<ulid>/`. Point the same variable at a scratch directory when you want
to record throwaway sessions without touching your real `~/.agentrec`:

```bash
AGENTREC_HOME=/tmp/abb-scratch node packages/cli/bin/agentrec.js claude
```

To add a fixture, record a session and export/import it into `fixtures`, or copy a session directory
in by hand. Keep fixtures small, and **scrub them** — they are committed to a public repo. See
[docs/security.md](docs/security.md) for what a recording contains.

## Commit style

Conventional commits, lowercase subject, no trailing period:

```text
<type>(<scope>): <subject>
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`.
Scopes are the package or area: `core`, `cli`, `dashboard`, `docs`, `ci`.

```text
feat(cli): stream cast lines to the dashboard over SSE
fix(core): stop double-counting usage across content blocks
docs(format): document the .agentlog container
refactor(dashboard): extract the playhead reducer
```

Breaking changes get a `!` and a `BREAKING CHANGE:` footer explaining the migration:

```text
feat(core)!: drop toolUseId from file.change

BREAKING CHANGE: bumps formatVersion to 2. Sessions recorded with formatVersion 1 must be
read through the compatibility path in session-store.ts.
```

## Pull requests

- **Branch from `main`** and keep the PR focused on one thing. A large PR that does three things
  takes longer to land than three small ones.
- **Green CI:** `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`. Run them locally
  first; that is exactly what CI runs.
- **Tests for behavior changes.** `core` is pure data handling and easy to test — parsers, reducers,
  and the store all deserve cases. Bug fixes should come with a test that fails without the fix.
- **Say how you tested it.** Especially for the recorder and the UI, where automated coverage is
  thin. Name the terminal or browser you used.
- **Format changes are a bigger deal than code changes.** Anything touching
  `packages/core/src/types.ts` or the on-disk layout needs a matching update to
  [docs/format.md](docs/format.md), and a note on whether existing recordings still read. Additive,
  optional fields and new event types are compatible by policy; removals and type changes are not
  and require a `formatVersion` bump.
- **Discuss large features in an issue first.** Anything on the roadmap, or anything that adds a
  dependency, is worth agreeing on before you build it.
- Dependencies: prefer none. The recorder's value is that it is small and local, and every added
  dependency is code that runs inside your development sessions.

Issues labeled `good first issue` are scoped to be self-contained and are a reasonable place to
start.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
