import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveFileChange } from "../src/recorder/file-changes.js";

function fixture(name: string): { tool_input: unknown; tool_response: unknown } {
  const url = new URL(`./fixtures/hook-payloads/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("deriveFileChange from a structuredPatch", () => {
  it("renders a positioned unified diff with the real line numbers", () => {
    const change = deriveFileChange(
      "Edit",
      { file_path: "/home/dev/app/x.ts", old_string: "b = 2;", new_string: "b = 3;" },
      {
        filePath: "/home/dev/app/x.ts",
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 3,
            lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;"],
          },
        ],
      },
    );
    expect(change).toEqual({
      path: "/home/dev/app/x.ts",
      kind: "edit",
      diff: [
        "--- a/home/dev/app/x.ts",
        "+++ b/home/dev/app/x.ts",
        "@@ -10,3 +10,3 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        " const c = 4;",
      ].join("\n"),
    });
  });

  it("emits one hunk header per structuredPatch hunk", () => {
    const change = deriveFileChange(
      "Edit",
      { file_path: "x.ts", old_string: "x", new_string: "y" },
      {
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+A"] },
          { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ["-b", "+B"] },
        ],
      },
    );
    expect(change?.diff).toBe(
      [
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+A",
        "@@ -20,1 +20,1 @@",
        "-b",
        "+B",
      ].join("\n"),
    );
  });

  it("renders the real captured Edit fixture as a positioned diff", () => {
    const { tool_input, tool_response } = fixture("post-tool-use-edit");
    const change = deriveFileChange("Edit", tool_input, tool_response);
    const path = (tool_input as { file_path: string }).file_path.replace(/^\/+/, "");
    expect(change?.kind).toBe("edit");
    expect(change?.diff).toBe(
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,1 +1,1 @@",
        "-export const a = 1;",
        "+export const a = 2;",
      ].join("\n"),
    );
  });

  it("keeps a Write a creation and renders its whole-file additions from the patch", () => {
    const change = deriveFileChange(
      "Write",
      { file_path: "y.ts", content: "one\ntwo\n" },
      {
        filePath: "y.ts",
        structuredPatch: [
          { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] },
        ],
      },
    );
    expect(change).toEqual({
      path: "y.ts",
      kind: "create",
      diff: ["--- a/y.ts", "+++ b/y.ts", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
    });
  });

  it("falls back to the create diff when the real Write fixture's patch is empty", () => {
    const { tool_input, tool_response } = fixture("post-tool-use-write");
    const change = deriveFileChange("Write", tool_input, tool_response);
    expect(change).toEqual({
      path: (tool_input as { file_path: string }).file_path,
      kind: "create",
      diff: [
        `--- a/${(tool_input as { file_path: string }).file_path.replace(/^\/+/, "")}`,
        `+++ b/${(tool_input as { file_path: string }).file_path.replace(/^\/+/, "")}`,
        "@@ -0,0 +1,1 @@",
        "+hello",
      ].join("\n"),
    });
  });

  it("caps a structuredPatch diff with the truncation marker", () => {
    const change = deriveFileChange(
      "Write",
      { file_path: "big.txt", content: "x".repeat(300_000) },
      {
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [`+${"x".repeat(300_000)}`],
          },
        ],
      },
    );
    expect(change?.kind).toBe("create");
    expect(change?.diff).toHaveLength(200 * 1024 + "\n…[truncated]".length);
    expect(change?.diff.endsWith("\n…[truncated]")).toBe(true);
  });

  it("degrades to the reconstructed fallback when the structuredPatch is malformed", () => {
    const change = deriveFileChange(
      "Edit",
      { file_path: "x.ts", old_string: "a", new_string: "b" },
      { structuredPatch: [{ oldStart: "nope", lines: 5 }] },
    );
    expect(change?.diff).toBe(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"),
    );
  });

  it("returns undefined without throwing when neither a valid patch nor input fields exist", () => {
    expect(
      deriveFileChange("Edit", { file_path: "x.ts" }, { structuredPatch: "garbage" }),
    ).toBeUndefined();
  });

  it("takes the path from the response when the tool input lacks one", () => {
    const change = deriveFileChange("Edit", undefined, {
      filePath: "/home/dev/app/z.ts",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
      ],
    });
    expect(change?.path).toBe("/home/dev/app/z.ts");
    expect(change?.diff).toContain("--- a/home/dev/app/z.ts");
  });
});

describe("deriveFileChange", () => {
  it("builds a unified-shaped diff for an Edit", () => {
    const change = deriveFileChange("Edit", {
      file_path: "/home/dev/app/x.ts",
      old_string: "const a = 1;\nconst b = 2;\n",
      new_string: "const a = 1;\nconst b = 3;\n",
    });
    expect(change).toEqual({
      path: "/home/dev/app/x.ts",
      kind: "edit",
      diff: [
        "--- a/home/dev/app/x.ts",
        "+++ b/home/dev/app/x.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "-const b = 2;",
        "+const a = 1;",
        "+const b = 3;",
      ].join("\n"),
    });
  });

  it("treats a Write as a creation with only added lines", () => {
    const change = deriveFileChange("Write", {
      file_path: "app/y.ts",
      content: "one\ntwo\n",
    });
    expect(change).toEqual({
      path: "app/y.ts",
      kind: "create",
      diff: ["--- a/app/y.ts", "+++ b/app/y.ts", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
    });
  });

  it("handles an insertion into an empty selection", () => {
    const change = deriveFileChange("Edit", {
      file_path: "y.ts",
      old_string: "",
      new_string: "added",
    });
    expect(change?.diff).toBe(["--- a/y.ts", "+++ b/y.ts", "@@ -0,0 +1,1 @@", "+added"].join("\n"));
  });

  it("caps very large diffs with a truncation marker", () => {
    const change = deriveFileChange("Write", {
      file_path: "big.txt",
      content: "x".repeat(300_000),
    });
    expect(change?.diff).toHaveLength(200 * 1024 + "\n…[truncated]".length);
    expect(change?.diff.endsWith("\n…[truncated]")).toBe(true);
  });

  it("ignores tools and payloads it cannot describe", () => {
    expect(deriveFileChange("Bash", { command: "ls" })).toBeUndefined();
    expect(deriveFileChange("Edit", { file_path: "x.ts" })).toBeUndefined();
    expect(deriveFileChange("Write", { content: "x" })).toBeUndefined();
    expect(deriveFileChange("Write", { file_path: "", content: "x" })).toBeUndefined();
    expect(deriveFileChange("Edit", "not an object")).toBeUndefined();
    expect(deriveFileChange("Edit", undefined)).toBeUndefined();
  });
});
