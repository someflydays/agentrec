# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: go to the repository's **Security** tab and choose
**Report a vulnerability** ([private vulnerability
reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)).
That opens a draft advisory visible only to you and the maintainers, and it is the fastest way to
reach someone.

Helpful things to include, to whatever extent you have them:

- What an attacker can achieve, and what access they need to start.
- Affected version — `agent-blackbox --version` — plus OS and Node version.
- Reproduction steps or a proof of concept. If a session recording demonstrates it, **review it for
  your own secrets first**; a redacted description is better than an unreviewed recording.
- Any suggested fix or mitigation you have in mind.

## Response expectations

This is a small, primarily volunteer-maintained project. Best-effort targets:

| Stage                                              | Target                |
| -------------------------------------------------- | --------------------- |
| Acknowledgement that the report was received       | 3 business days       |
| Initial assessment, severity, and whether accepted | 10 business days      |
| Fix released for accepted high-severity issues     | 30 days where feasible|
| Public advisory                                    | With or shortly after the fix |

If you do not hear back within 10 business days, please bump the advisory thread — a missed
notification is far more likely than a deliberate silence.

We will keep you updated as the assessment progresses, credit you in the advisory unless you prefer
otherwise, and coordinate timing with you before publishing. Please give us a reasonable window to
ship a fix before disclosing publicly; 90 days is a good default, and we will usually be much faster.

## Supported versions

The project is pre-1.0. Only the latest published version of `@agent-blackbox/cli` receives security
fixes. Fixes ship in a new patch or minor release rather than being backported.

## In scope

Issues in this repository's code, particularly anything that breaks a stated guarantee in the
[security model](docs/security.md):

- Terminal **input** or keystrokes appearing in a recording.
- The recorder reading or writing the user's Claude Code settings files, or leaving injected hook
  configuration behind after the process exits.
- Recording data written outside the session store root (`~/.agent-blackbox` or
  `AGENT_BLACKBOX_HOME`).
- Path traversal or arbitrary file write when importing a crafted `.agentlog`.
- Code execution, command injection, or privilege escalation triggered by recorded content,
  a crafted `.agentlog`, or hook payloads.
- The dashboard server binding anything other than loopback, or being reachable off-machine.
- Cross-site scripting or origin issues in the dashboard that let a web page read session data.
- Any outbound network request made by the recorder or the dashboard server.
- Secrets being written to a location the documentation does not disclose.

## Out of scope

Documented, intentional properties — worth improving, but not vulnerabilities. Please file these as
regular issues or feature requests:

- **Recordings contain whatever was on screen.** Tool output, file diffs, and printed credentials are
  captured by design. This is the product working as documented.
- **No redaction on export.** A redaction pass is on the roadmap; its absence is a known gap.
- **The local dashboard server is unauthenticated.** Loopback binding is the documented access
  control, so any local process can read sessions while the server runs.
- **No encryption at rest**, and recordings use your user's default file permissions.
- **No integrity protection on `.agentlog` files.** They are unsigned and editable after export.
- Vulnerabilities in Claude Code, Node.js, or third-party dependencies — report those upstream.
  Do tell us if this project's usage makes an upstream issue meaningfully worse.
- Findings that require an attacker to already have your user account or root on the machine.
- Automated scanner output with no demonstrated impact, and social engineering.

## Related

- [docs/security.md](docs/security.md) — the full threat model: what is recorded, what is never
  recorded, network posture, and what to check before sharing a recording.
