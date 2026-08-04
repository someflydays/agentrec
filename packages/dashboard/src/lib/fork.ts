/** Characters that survive an unquoted POSIX shell word untouched. */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * POSIX single-quoting: everything inside is literal, so a prompt containing
 * `$HOME`, a backtick or a newline is pasted into a shell exactly as typed.
 */
function shellQuote(argument: string): string {
  if (argument.length > 0 && BARE_WORD.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

/** The CLI equivalent of what the dashboard's fork panel would run. */
export function forkCommand(sessionId: string, seq: number, prompt: string): string {
  const trimmed = prompt.trim();
  return [
    "agentrec",
    "fork",
    sessionId,
    "--at",
    String(seq),
    ...(trimmed.length > 0 ? ["--prompt", trimmed] : []),
    "--experimental",
  ]
    .map(shellQuote)
    .join(" ");
}
