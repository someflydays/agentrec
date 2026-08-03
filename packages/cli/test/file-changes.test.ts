import { describe, expect, it } from "vitest";
import { deriveFileChange } from "../src/recorder/file-changes.js";

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
