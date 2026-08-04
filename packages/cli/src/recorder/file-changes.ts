import { TRUNCATION_MARKER, truncate } from "../format.js";
import { asNonEmptyString, asRecord, asString } from "./json.js";

/**
 * A successful Edit/Write PostToolUse carries `tool_response.structuredPatch`: a
 * positioned unified diff Claude Code already computed, which is rendered here
 * verbatim. Older recordings and the pre-hook `tool_input`-only path lack it, so
 * the diff is then reconstructed from `old_string`/`new_string` as a single
 * nominal hunk with no real line numbers.
 */
const MAX_DIFF_CHARS = 200 * 1024;

export interface DerivedFileChange {
  path: string;
  kind: "create" | "edit";
  diff: string;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Absolute paths would render as "a//Users/..."; the untouched path is in `path`.
function label(path: string): string {
  return path.replace(/^\/+/, "");
}

function kindForTool(toolName: string): DerivedFileChange["kind"] | undefined {
  if (toolName === "Write") return "create";
  if (toolName === "Edit") return "edit";
  return undefined;
}

function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline terminates the last line rather than starting a new one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function range(lines: string[]): string {
  return lines.length === 0 ? "0,0" : `1,${lines.length}`;
}

/**
 * Renders the diff from a PostToolUse `structuredPatch`. Returns undefined when
 * absent, empty, or malformed at any field so the caller degrades to the
 * reconstructed fallback rather than emitting a broken diff.
 */
function diffFromStructuredPatch(path: string, response: unknown): string | undefined {
  const hunks = asRecord(response)?.structuredPatch;
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined;

  const parts = [`--- a/${label(path)}`, `+++ b/${label(path)}`];
  for (const raw of hunks) {
    const hunk = asRecord(raw);
    if (hunk === undefined) return undefined;
    const oldStart = asFiniteNumber(hunk.oldStart);
    const oldLines = asFiniteNumber(hunk.oldLines);
    const newStart = asFiniteNumber(hunk.newStart);
    const newLines = asFiniteNumber(hunk.newLines);
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      return undefined;
    }
    if (!Array.isArray(hunk.lines) || hunk.lines.some((line) => typeof line !== "string")) {
      return undefined;
    }
    // `lines` already carry their ` `/`+`/`-` prefixes, so they are kept verbatim.
    parts.push(
      `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      ...(hunk.lines as string[]),
    );
  }
  return parts.join("\n");
}

/** Reconstructs a nominal, positionless hunk from the tool input alone. */
function diffFromToolInput(toolName: string, path: string, input: unknown): string | undefined {
  const record = asRecord(input);
  if (record === undefined) return undefined;

  let before: string | undefined;
  let after: string | undefined;
  if (toolName === "Edit") {
    before = asString(record.old_string);
    after = asString(record.new_string);
  } else {
    before = "";
    after = asString(record.content);
  }
  if (before === undefined || after === undefined) return undefined;

  const oldLines = toLines(before);
  const newLines = toLines(after);
  return [
    `--- a/${label(path)}`,
    `+++ b/${label(path)}`,
    `@@ -${range(oldLines)} +${range(newLines)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

/**
 * Undefined for tools that don't write files, and for payloads missing the
 * fields we need. `toolResponse` is optional: a caller with only the pre-hook
 * `tool_input` still derives a fallback diff.
 */
export function deriveFileChange(
  toolName: string,
  toolInput: unknown,
  toolResponse?: unknown,
): DerivedFileChange | undefined {
  const kind = kindForTool(toolName);
  if (kind === undefined) return undefined;

  const path =
    asNonEmptyString(asRecord(toolInput)?.file_path) ??
    asNonEmptyString(asRecord(toolResponse)?.filePath);
  if (path === undefined) return undefined;

  const diff =
    diffFromStructuredPatch(path, toolResponse) ?? diffFromToolInput(toolName, path, toolInput);
  if (diff === undefined) return undefined;

  return { path, kind, diff: truncate(diff, MAX_DIFF_CHARS, `\n${TRUNCATION_MARKER}`) };
}
