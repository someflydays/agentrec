import {
  type AlignedTurn,
  diffSessions,
  type SessionDiff,
  type SessionInput,
  SessionStore,
  type SessionSummary,
  type SessionTurn,
  type SetDiff,
  type ToolAlignment,
} from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { ABSENT, formatCost, formatDuration, formatTokenCount, truncate } from "../format.js";

const MAX_SET_LINES = 6;
const MAX_ENTRY_CHARS = 68;
const MAX_PROMPT_CHARS = 76;
const MAX_DETAIL_CHARS = 52;
const MAX_MODELS_CHARS = 20;
const TOOL_NAME_WIDTH = 12;
/** Where a tool line's detail starts: indent, marker, space, name, space. */
const DETAIL_INDENT = " ".repeat(4 + 2 + TOOL_NAME_WIDTH + 1);

interface Cell {
  text: string;
  color?: (text: string) => string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderRow(cells: Cell[], widths: number[]): string {
  return cells
    .map((cell, index) => {
      const width = widths[index] ?? cell.text.length;
      // Pad before colouring: ANSI escapes would otherwise count towards width.
      const padded = index === 0 ? cell.text.padEnd(width) : cell.text.padStart(width);
      return cell.color === undefined ? padded : cell.color(padded);
    })
    .join("  ")
    .trimEnd();
}

function deltaCell(delta: number | null, format: (value: number) => string): Cell {
  if (delta === null || delta === 0) return { text: ABSENT, color: pc.dim };
  const sign = delta > 0 ? "+" : "-";
  return { text: `${sign}${format(Math.abs(delta))}`, color: delta > 0 ? pc.green : pc.red };
}

/** Vendor prefixes are noise in a column this narrow: claude-opus-5 → opus-5. */
function modelNames(summary: SessionSummary): string {
  if (summary.models.length === 0) return ABSENT;
  const names = summary.models.map((entry) => entry.model.replace(/^(anthropic\.)?claude-/, ""));
  return truncate(names.join(", "), MAX_MODELS_CHARS);
}

function optionalDuration(ms: number | null): string {
  return ms === null ? ABSENT : formatDuration(ms);
}

function summaryTable(diff: SessionDiff): string[] {
  const { totals } = diff;
  const filesA = diff.a.filesChanged.length;
  const filesB = diff.b.filesChanged.length;
  const rows: Cell[][] = [
    [
      { text: "" },
      { text: "A", color: pc.red },
      { text: "B", color: pc.green },
      { text: "Δ", color: pc.dim },
    ],
    [
      { text: "duration" },
      { text: optionalDuration(totals.durationMs.a) },
      { text: optionalDuration(totals.durationMs.b) },
      deltaCell(totals.durationMs.delta, formatDuration),
    ],
    [
      { text: "models" },
      { text: modelNames(diff.a) },
      { text: modelNames(diff.b) },
      { text: ABSENT, color: pc.dim },
    ],
    [
      { text: "prompts" },
      { text: String(totals.prompts.a) },
      { text: String(totals.prompts.b) },
      deltaCell(totals.prompts.delta, String),
    ],
    [
      { text: "tool calls" },
      { text: String(totals.toolCalls.a) },
      { text: String(totals.toolCalls.b) },
      deltaCell(totals.toolCalls.delta, String),
    ],
    [
      { text: "failed calls" },
      { text: String(totals.failedToolCalls.a) },
      { text: String(totals.failedToolCalls.b) },
      deltaCell(totals.failedToolCalls.delta, String),
    ],
    [
      { text: "files changed" },
      { text: String(filesA) },
      { text: String(filesB) },
      deltaCell(filesB - filesA, String),
    ],
    [
      { text: "tokens in" },
      { text: formatTokenCount(totals.usage.a.inputTokens) },
      { text: formatTokenCount(totals.usage.b.inputTokens) },
      deltaCell(totals.usage.delta.inputTokens, formatTokenCount),
    ],
    [
      { text: "tokens out" },
      { text: formatTokenCount(totals.usage.a.outputTokens) },
      { text: formatTokenCount(totals.usage.b.outputTokens) },
      deltaCell(totals.usage.delta.outputTokens, formatTokenCount),
    ],
    [
      { text: "cost" },
      { text: formatCost(totals.costUsd.a) },
      { text: formatCost(totals.costUsd.b) },
      deltaCell(totals.costUsd.delta, (value) => formatCost(value)),
    ],
  ];

  const widths = [0, 1, 2, 3].map((index) =>
    Math.max(...rows.map((row) => row[index]?.text.length ?? 0)),
  );
  return rows.map((row) => renderRow(row, widths));
}

function alignmentLines(diff: SessionDiff): string[] {
  const turns = [`${diff.turns.length} paired`];
  if (diff.onlyInA.length > 0) turns.push(`${diff.onlyInA.length} only in A`);
  if (diff.onlyInB.length > 0) turns.push(`${diff.onlyInB.length} only in B`);

  const counts = diff.totals.toolAlignment;
  const tools = [`${counts.same} same`];
  if (counts.changed > 0) tools.push(`${counts.changed} changed`);
  if (counts.onlyA > 0) tools.push(`${counts.onlyA} only in A`);
  if (counts.onlyB > 0) tools.push(`${counts.onlyB} only in B`);

  return [`turns  ${turns.join(" · ")}`, `tools  ${tools.join(" · ")}`];
}

function setSection(title: string, sets: SetDiff): string[] {
  const groups = [
    { label: "only in A", marker: "-", color: pc.red, values: sets.onlyA },
    { label: "only in B", marker: "+", color: pc.green, values: sets.onlyB },
    { label: "in both", marker: "=", color: pc.dim, values: sets.both },
  ];
  const lines = [title];
  if (groups.every((group) => group.values.length === 0)) {
    lines.push(`  ${pc.dim("none")}`);
    return lines;
  }
  for (const group of groups) {
    if (group.values.length === 0) continue;
    lines.push(pc.dim(`  ${group.label} (${group.values.length})`));
    for (const value of group.values.slice(0, MAX_SET_LINES)) {
      lines.push(`    ${group.color(group.marker)} ${truncate(oneLine(value), MAX_ENTRY_CHARS)}`);
    }
    const hidden = group.values.length - MAX_SET_LINES;
    if (hidden > 0) lines.push(pc.dim(`    … ${hidden} more`));
  }
  return lines;
}

function toolLine(
  marker: string,
  color: (text: string) => string,
  name: string,
  detail: string,
): string {
  if (detail.length === 0) return `    ${color(marker)} ${name}`;
  return `    ${color(marker)} ${name.padEnd(TOOL_NAME_WIDTH)} ${detail}`;
}

function detailText(detail: string | null): string {
  return detail === null ? "" : pc.dim(truncate(oneLine(detail), MAX_DETAIL_CHARS));
}

function sideDetail(label: string, color: (text: string) => string, detail: string | null): string {
  const text = detailText(detail);
  return text.length === 0 ? color(label) : `${color(label)} ${text}`;
}

/** A changed call spends two lines: the inputs usually differ deep in a path. */
function toolAlignmentLines(entry: ToolAlignment): string[] {
  switch (entry.status) {
    case "same":
      return [toolLine("=", pc.dim, entry.a.name, detailText(entry.a.detail))];
    case "changed": {
      if (entry.a.detail === entry.b.detail) {
        const note = pc.dim(`${entry.a.detail ?? ""} (inputs differ)`.trimStart());
        return [toolLine("~", pc.yellow, entry.a.name, note)];
      }
      return [
        toolLine("~", pc.yellow, entry.a.name, sideDetail("A", pc.red, entry.a.detail)),
        `${DETAIL_INDENT}${sideDetail("B", pc.green, entry.b.detail)}`,
      ];
    }
    case "only-a":
      return [toolLine("-", pc.red, entry.a.name, detailText(entry.a.detail))];
    default:
      return [toolLine("+", pc.green, entry.b.name, detailText(entry.b.detail))];
  }
}

function pairedTurnLines(turn: AlignedTurn, position: number): string[] {
  const similarity = turn.similarity.toFixed(2);
  const lines = [pc.dim(`turn ${position}  similarity ${similarity}`)];
  const promptA = truncate(oneLine(turn.a.prompt), MAX_PROMPT_CHARS);
  const promptB = truncate(oneLine(turn.b.prompt), MAX_PROMPT_CHARS);
  if (promptA === promptB) {
    lines.push(`  ${promptA}`);
  } else {
    lines.push(`  ${pc.red("A")} ${promptA}`, `  ${pc.green("B")} ${promptB}`);
  }
  for (const entry of turn.tools) lines.push(...toolAlignmentLines(entry));
  return lines;
}

function unpairedTurnLines(turn: SessionTurn, side: "A" | "B"): string[] {
  const color = side === "A" ? pc.red : pc.green;
  const marker = side === "A" ? "-" : "+";
  const lines = [
    pc.dim(`turn only in ${side}`),
    `  ${color(side)} ${truncate(oneLine(turn.prompt), MAX_PROMPT_CHARS)}`,
  ];
  for (const call of turn.toolCalls) {
    lines.push(toolLine(marker, color, call.name, detailText(call.detail)));
  }
  return lines;
}

function readSession(store: SessionStore, id: string): SessionInput {
  return { meta: store.readMeta(id), events: store.readEvents(id) };
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Compare two recorded sessions and show what differed")
    .argument("<a>", "session id or unique id prefix")
    .argument("<b>", "session id or unique id prefix")
    .option("--json", "print the structured diff as JSON")
    .option("--full", "also print the per-turn tool alignment")
    .action((a: string, b: string, options: { json?: boolean; full?: boolean }) => {
      const store = new SessionStore();
      const idA = store.resolveId(a);
      const idB = store.resolveId(b);
      const diff = diffSessions(readSession(store, idA), readSession(store, idB));

      if (options.json === true) {
        console.log(JSON.stringify(diff, null, 2));
        return;
      }

      for (const [label, color, summary] of [
        ["A", pc.red, diff.a],
        ["B", pc.green, diff.b],
      ] as const) {
        const title = summary.title === undefined ? pc.dim(ABSENT) : summary.title;
        console.log(`${color(label)}  ${summary.id.slice(0, 8).toLowerCase()}  ${title}`);
      }

      console.log("");
      for (const line of summaryTable(diff)) console.log(line);
      console.log("");
      for (const line of alignmentLines(diff)) console.log(pc.dim(line));

      if (diff.identical) {
        console.log("");
        console.log(pc.dim("No differences."));
      } else {
        for (const section of [
          setSection("files changed", diff.totals.files),
          setSection("commands", diff.totals.commands),
        ]) {
          console.log("");
          for (const line of section) console.log(line);
        }
      }

      if (options.full !== true) {
        if (!diff.identical) {
          console.log("");
          console.log(pc.dim("Run with --full for the per-turn tool alignment."));
        }
        return;
      }

      const blocks = [
        ...diff.turns.map((turn, index) => pairedTurnLines(turn, index + 1)),
        ...diff.onlyInA.map((turn) => unpairedTurnLines(turn, "A")),
        ...diff.onlyInB.map((turn) => unpairedTurnLines(turn, "B")),
      ];
      for (const block of blocks) {
        console.log("");
        for (const line of block) console.log(line);
      }
    });
}
