import type { SessionDiff } from "@agentrec/core/browser";

export type { SessionDiff };
export type DiffTotals = SessionDiff["totals"];
export type SetDiff = DiffTotals["files"];
export type NumericDiff = DiffTotals["prompts"];
export type NullableNumericDiff = DiffTotals["costUsd"];
export type AlignedTurn = SessionDiff["turns"][number];
export type SessionTurn = SessionDiff["onlyInA"][number];
export type ToolAlignment = AlignedTurn["tools"][number];
export type ToolCall = SessionTurn["toolCalls"][number];

/** B gained ground, B lost ground, or nothing moved — matching `agentrec diff`. */
export type DeltaTone = "up" | "down" | "flat";

export function deltaTone(delta: number | null): DeltaTone {
  if (delta === null || delta === 0) return "flat";
  return delta > 0 ? "up" : "down";
}

export function formatDelta(delta: number | null, format: (value: number) => string): string {
  if (delta === null || delta === 0) return "—";
  return `${delta > 0 ? "+" : "-"}${format(Math.abs(delta))}`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
