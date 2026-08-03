import { TRUNCATION_MARKER, truncate } from "../format.js";
import { asNonEmptyString, asRecord, asString } from "./json.js";

/**
 * Edit/Write hook payloads carry the replaced text but not its position in the
 * file, so the derived diff is unified-shaped for readability and tooling, with
 * a nominal hunk header.
 */
const MAX_DIFF_CHARS = 200 * 1024;

export interface DerivedFileChange {
  path: string;
  kind: "create" | "edit";
  diff: string;
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

function buildDiff(path: string, before: string, after: string): string {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  // Absolute paths would read as "a//Users/..."; the untouched path is in `path`.
  const label = path.replace(/^\/+/, "");
  const diff = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${range(oldLines)} +${range(newLines)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
  return truncate(diff, MAX_DIFF_CHARS, `\n${TRUNCATION_MARKER}`);
}

/** Undefined for tools that don't write files, and for payloads missing the fields we need. */
export function deriveFileChange(
  toolName: string,
  toolInput: unknown,
): DerivedFileChange | undefined {
  const input = asRecord(toolInput);
  if (input === undefined) return undefined;
  const path = asNonEmptyString(input.file_path);
  if (path === undefined) return undefined;

  if (toolName === "Edit") {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    if (before === undefined || after === undefined) return undefined;
    return { path, kind: "edit", diff: buildDiff(path, before, after) };
  }

  if (toolName === "Write") {
    const content = asString(input.content);
    if (content === undefined) return undefined;
    return { path, kind: "create", diff: buildDiff(path, "", content) };
  }

  return undefined;
}
