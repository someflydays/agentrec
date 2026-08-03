/** Stands in for a value that does not exist: a live session, an unpriced model. */
export const ABSENT = "—";

/** Appended to captured payloads that were cut down to stay small enough to keep in-band. */
export const TRUNCATION_MARKER = "…[truncated]";

function trimZeroDecimal(value: number): string {
  const text = value.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return ABSENT;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZeroDecimal(n / 1000)}k`;
  return `${trimZeroDecimal(n / 1_000_000)}M`;
}

export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return ABSENT;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${trimZeroDecimal(kb)} KB`;
  return `${trimZeroDecimal(kb / 1024)} MB`;
}

export function truncate(text: string, maxChars: number, marker = "…"): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${marker}`;
}
