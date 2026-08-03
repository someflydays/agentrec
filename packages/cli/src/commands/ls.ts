import { SessionStore, type SessionSummary, summarizeSession } from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import {
  ABSENT,
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
  truncate,
} from "../format.js";

const MAX_TITLE_CHARS = 40;

const COLUMNS = [
  { header: "ID", align: "left" },
  { header: "TITLE", align: "left" },
  { header: "STARTED", align: "left" },
  { header: "DURATION", align: "left" },
  { header: "PROMPTS", align: "right" },
  { header: "TOOLS", align: "right" },
  { header: "TOKENS", align: "right" },
  { header: "COST", align: "right" },
] as const;

function toRow(summary: SessionSummary): string[] {
  const { inputTokens, outputTokens } = summary.totalUsage;
  return [
    summary.id.slice(0, 8).toLowerCase(),
    summary.title === undefined ? ABSENT : truncate(summary.title, MAX_TITLE_CHARS),
    formatRelativeTime(summary.startedAt),
    summary.durationMs === null ? ABSENT : formatDuration(summary.durationMs),
    String(summary.prompts),
    String(summary.toolCalls),
    // Cache tokens are excluded here but included in the cost estimate.
    formatTokenCount(inputTokens + outputTokens),
    formatCost(summary.totalCostUsd),
  ];
}

function renderRow(cells: string[], widths: number[]): string {
  return cells
    .map((cell, index) => {
      const width = widths[index] ?? cell.length;
      return COLUMNS[index]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
    })
    .join("  ")
    .trimEnd();
}

export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("List recorded sessions, newest first")
    .option("--json", "print the session summaries as JSON")
    .action((options: { json?: boolean }) => {
      const store = new SessionStore();
      const summaries = store
        .list()
        .map((meta) => summarizeSession(meta, store.readEvents(meta.id)));

      if (options.json === true) {
        console.log(JSON.stringify(summaries, null, 2));
        return;
      }
      if (summaries.length === 0) {
        console.log(`No sessions recorded yet. Start one with ${pc.bold("agentrec claude")}.`);
        return;
      }

      const headers = COLUMNS.map((column) => column.header);
      const rows = summaries.map(toRow);
      const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
      );
      console.log(pc.dim(renderRow(headers, widths)));
      for (const row of rows) console.log(renderRow(row, widths));
    });
}
