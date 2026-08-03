const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Playback offsets: mm:ss, widening to h:mm:ss past an hour. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const tail = `${pad(minutes)}:${pad(seconds)}`;
  return hours > 0 ? `${String(hours)}:${tail}` : tail;
}

export function formatSeconds(seconds: number): string {
  return formatOffset(seconds * SECOND);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < SECOND) return `${String(Math.max(0, Math.round(ms)))}ms`;
  if (ms < MINUTE) return `${trim(ms / SECOND)}s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    return `${String(minutes)}m ${String(Math.round((ms % MINUTE) / SECOND))}s`;
  }
  const hours = Math.floor(ms / HOUR);
  return `${String(hours)}h ${String(Math.round((ms % HOUR) / MINUTE))}m`;
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const delta = now - then;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${String(Math.floor(delta / MINUTE))}m ago`;
  if (delta < DAY) return `${String(Math.floor(delta / HOUR))}h ago`;
  if (delta < 7 * DAY) return `${String(Math.floor(delta / DAY))}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = new Date().toDateString() === date.toDateString();
  if (isToday) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trim(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

export function formatCount(count: number): string {
  return count.toLocaleString();
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Model ids carry a date suffix that adds nothing in a dense table. */
export function shortModel(model: string): string {
  return model.replace(/^anthropic\./, "").replace(/-\d{8}$/, "");
}

export function firstLine(text: string, max = 160): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One-line gist of a tool call. Claude Code's schemas are stable enough to key
 * off the obvious field per tool, with a generic fallback for MCP tools.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;

  const primary = PRIMARY_FIELDS[name];
  if (primary !== undefined) {
    const value = fields[primary];
    if (typeof value === "string" && value.length > 0) return firstLine(value);
  }

  for (const key of GENERIC_FIELDS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) return firstLine(value);
  }

  const keys = Object.keys(fields);
  return keys.length === 0 ? "" : firstLine(keys.join(", "), 80);
}

const PRIMARY_FIELDS: Readonly<Record<string, string>> = {
  Bash: "command",
  BashOutput: "bash_id",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Glob: "pattern",
  Grep: "pattern",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
  SlashCommand: "command",
};

const GENERIC_FIELDS = ["command", "file_path", "path", "pattern", "query", "url", "description"];

export function formatExitCode(exitCode: number | null | undefined): string {
  if (exitCode === null || exitCode === undefined) return "—";
  return String(exitCode);
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function trim(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
