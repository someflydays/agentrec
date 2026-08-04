import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  indexPath,
  MATCH_CLOSE,
  MATCH_OPEN,
  rebuildIndex,
  SearchQueryError,
  type SearchResult,
  search,
  syncIndex,
  toMatchExpression,
} from "../src/search.js";
import { EVENTS_FILE, SessionStore } from "../src/session-store.js";
import type { SessionMeta } from "../src/types.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

const ID_A = "01TESTAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01TESTBBBBBBBBBBBBBBBBBBBB";

function baseMeta(id: string, startedAt: string): Omit<SessionMeta, "formatVersion"> {
  return {
    id,
    agent: "claude-code",
    command: ["claude"],
    cwd: "/work/project",
    startedAt,
  };
}

function seqsOf(results: SearchResult[]): number[] {
  return results.map((result) => result.seq);
}

describe("search", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = makeTempDir();
    store = new SessionStore(root);
  });

  afterEach(() => {
    removeTempDir(root);
  });

  function seedSessionA(): void {
    const writer = store.createSession(baseMeta(ID_A, "2026-03-04T10:00:00.000Z"));
    writer.event("session.title", { title: "Fix flaky watchdog test" });
    writer.event("prompt", { text: "the watchdog test fails about one run in five on CI" });
    writer.event("assistant.text", {
      text: "The watchdog arms a real setTimeout while the test advances a fake clock.",
    });
    writer.event("tool.start", {
      name: "Bash",
      input: { command: "pnpm vitest run tests/watchdog.test.ts", timeout: 120_000 },
    });
    writer.event("tool.end", { name: "Bash", ok: false, output: "AssertionError: expected armed" });
    writer.event("file.change", { path: "/work/project/src/sim/watchdog.ts", kind: "edit" });
    writer.event("notification", { message: "waiting for permission to run pnpm" });
    writer.end(0);
  }

  function seedSessionB(): void {
    const writer = store.createSession(baseMeta(ID_B, "2026-03-05T10:00:00.000Z"));
    writer.event("prompt", { text: "generate a changelog from the release commits" });
    writer.event("assistant.text", { text: "Reading the git history for the changelog." });
    writer.end(0);
  }

  it("returns nothing for an empty store", () => {
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 0, removed: 0 });
    expect(search(store, "anything")).toEqual([]);
  });

  it("creates the index file under the store root", () => {
    seedSessionA();
    syncIndex(store);
    expect(indexPath(store)).toBe(join(root, "index.db"));
    expect(existsSync(indexPath(store))).toBe(true);
  });

  it("finds a prompt by a distinctive word", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);

    const hits = search(store, "watchdog", { types: ["prompt"] });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.sessionId).toBe(ID_A);
    expect(hit?.sessionTitle).toBe("Fix flaky watchdog test");
    expect(hit?.sessionStartedAt).toBe("2026-03-04T10:00:00.000Z");
    expect(hit?.type).toBe("prompt");
    expect(hit?.seq).toBe(2);
    expect(hit?.t).toBeGreaterThanOrEqual(0);
  });

  it("matches assistant text, tool input, tool output, notifications and file paths", () => {
    seedSessionA();
    syncIndex(store);

    expect(search(store, "setTimeout").map((hit) => hit.type)).toEqual(["assistant.text"]);
    expect(search(store, "vitest").map((hit) => hit.type)).toEqual(["tool.start"]);
    expect(search(store, "AssertionError").map((hit) => hit.type)).toEqual(["tool.end"]);
    expect(search(store, "permission").map((hit) => hit.type)).toEqual(["notification"]);
    expect(search(store, "sim").map((hit) => hit.type)).toEqual(["file.change"]);
  });

  it("does not index event types that carry no readable text", () => {
    const writer = store.createSession(baseMeta(ID_A, "2026-03-04T10:00:00.000Z"));
    writer.event("usage", {
      model: "claude-fable-5",
      requestId: "req_zebrafish",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
      },
    });
    writer.end(0);
    syncIndex(store);

    expect(search(store, "zebrafish")).toEqual([]);
  });

  it("filters by event type", () => {
    seedSessionA();
    syncIndex(store);

    const all = search(store, "watchdog");
    expect(all.length).toBeGreaterThan(2);
    const filtered = search(store, "watchdog", { types: ["tool.start", "file.change"] });
    expect(new Set(filtered.map((hit) => hit.type))).toEqual(
      new Set(["tool.start", "file.change"]),
    );
  });

  it("filters by session id", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);

    const hits = search(store, "the", { sessionId: ID_B });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.sessionId === ID_B)).toBe(true);
  });

  it("wraps the match in the snippet delimiters", () => {
    seedSessionA();
    syncIndex(store);

    const hit = search(store, "watchdog", { types: ["prompt"] })[0];
    expect(hit?.snippet).toContain(`${MATCH_OPEN}watchdog${MATCH_CLOSE}`);
    expect(hit?.snippet).toContain("fails about one run in five");
  });

  it("honors the limit and orders the strongest match first", () => {
    seedSessionA();
    syncIndex(store);

    const all = search(store, "watchdog");
    expect(all.map((hit) => hit.score)).toEqual(
      [...all.map((hit) => hit.score)].sort((a, b) => a - b),
    );
    const limited = search(store, "watchdog", { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(seqsOf(limited)).toEqual(seqsOf(all.slice(0, 2)));
  });

  it("requires every term of a multi-word query", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);

    expect(search(store, "watchdog changelog")).toEqual([]);
    expect(search(store, "flaky watchdog").length).toBeGreaterThan(0);
  });

  it("reindexes only the session whose events changed", () => {
    seedSessionA();
    seedSessionB();
    expect(syncIndex(store)).toEqual({ indexed: 2, skipped: 0, removed: 0 });
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 2, removed: 0 });

    const path = join(store.sessionDir(ID_B), EVENTS_FILE);
    const line = JSON.stringify({
      seq: 99,
      t: 5000,
      type: "prompt",
      data: { text: "also mention the aardvark migration" },
    });
    writeFileSync(path, `${line}\n`, { flag: "a" });

    expect(syncIndex(store)).toEqual({ indexed: 1, skipped: 1, removed: 0 });
    expect(search(store, "aardvark").map((hit) => hit.sessionId)).toEqual([ID_B]);
  });

  it("re-reads a live session on every sync", () => {
    const writer = store.createSession(baseMeta(ID_A, "2026-03-04T10:00:00.000Z"));
    writer.event("prompt", { text: "start the ocelot refactor" });

    expect(syncIndex(store).indexed).toBe(1);
    expect(syncIndex(store)).toEqual({ indexed: 1, skipped: 0, removed: 0 });
  });

  it("drops rows for a session that has been deleted", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);
    expect(search(store, "watchdog").length).toBeGreaterThan(0);

    store.delete(ID_A);
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 1, removed: 1 });
    expect(search(store, "watchdog")).toEqual([]);
    const survivors = search(store, "changelog");
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((hit) => hit.sessionId === ID_B)).toBe(true);
  });

  it("rebuilds the whole index on demand", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);
    expect(rebuildIndex(store)).toEqual({ indexed: 2, skipped: 0, removed: 0 });
    expect(search(store, "watchdog").length).toBeGreaterThan(0);
  });

  it("recovers from a corrupt index file", () => {
    seedSessionA();
    syncIndex(store);
    writeFileSync(indexPath(store), "this is not a sqlite database");

    expect(search(store, "watchdog").length).toBeGreaterThan(0);
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 1, removed: 0 });
  });

  it("recovers from an index written by another schema version", () => {
    seedSessionA();
    syncIndex(store);
    const db = new DatabaseSync(indexPath(store));
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schemaVersion'").run();
    db.close();

    expect(search(store, "watchdog").length).toBeGreaterThan(0);
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 1, removed: 0 });
  });

  it("never throws on adversarial queries", () => {
    seedSessionA();
    syncIndex(store);

    const queries = [
      '"',
      "foo:",
      "foo:bar",
      "*",
      "AND",
      "OR NOT NEAR",
      "",
      "   ",
      "(unbalanced",
      '"unclosed phrase',
      "a".repeat(50_000),
      Array.from({ length: 500 }, (_, index) => `term${index}`).join(" "),
    ];
    for (const query of queries) {
      expect(() => search(store, query)).not.toThrow();
    }
  });

  it("still matches when the query carries FTS5 punctuation", () => {
    seedSessionA();
    syncIndex(store);

    expect(search(store, "watchdog.test.ts").length).toBeGreaterThan(0);
    expect(search(store, '"watchdog"').length).toBeGreaterThan(0);
  });

  it("passes a raw query through to FTS5", () => {
    seedSessionA();
    seedSessionB();
    syncIndex(store);

    const hits = search(store, "watchdog OR changelog", { raw: true });
    expect(new Set(hits.map((hit) => hit.sessionId))).toEqual(new Set([ID_A, ID_B]));
    expect(search(store, "watchd*", { raw: true }).length).toBeGreaterThan(0);
  });

  it("reports a malformed raw query without discarding the index", () => {
    seedSessionA();
    syncIndex(store);

    expect(() => search(store, "watchdog AND", { raw: true })).toThrow(SearchQueryError);
    expect(syncIndex(store)).toEqual({ indexed: 0, skipped: 1, removed: 0 });
  });
});

describe("toMatchExpression", () => {
  it("quotes every term so punctuation cannot be read as syntax", () => {
    expect(toMatchExpression("foo:bar baz")).toBe('"foo:bar" "baz"');
  });

  it("doubles embedded quotes", () => {
    expect(toMatchExpression('say "hi"')).toBe('"say" """hi"""');
  });

  it("collapses to an empty expression for blank input", () => {
    expect(toMatchExpression("   ")).toBe("");
  });
});
