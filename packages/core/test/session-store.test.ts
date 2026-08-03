import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultStoreRoot,
  EVENTS_FILE,
  META_FILE,
  SessionStore,
  type SessionWriter,
} from "../src/session-store.js";
import type { SessionMeta } from "../src/types.js";
import { eventAt, expectEvent, makeTempDir, removeTempDir } from "./helpers.js";

const ID_A = "01TESTAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01TESTBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01ZZZZCCCCCCCCCCCCCCCCCCCC";

function baseMeta(
  id: string,
  startedAt = new Date().toISOString(),
): Omit<SessionMeta, "formatVersion"> {
  return {
    id,
    agent: "claude-code",
    command: ["claude", "--continue"],
    cwd: "/work/project",
    startedAt,
  };
}

describe("SessionStore", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = makeTempDir();
    store = new SessionStore(root);
  });

  afterEach(() => {
    removeTempDir(root);
  });

  it("creates a session with meta.json and a leading session.start event", () => {
    const startedAt = "2026-03-04T10:00:00.000Z";
    store.createSession(baseMeta(ID_A, startedAt));

    expect(store.has(ID_A)).toBe(true);
    expect(store.sessionDir(ID_A)).toBe(join(root, "sessions", ID_A));

    const events = store.readEvents(ID_A);
    expect(events).toHaveLength(1);
    const start = expectEvent(events, 0, "session.start");
    expect(start.seq).toBe(0);
    expect(start.data.meta.id).toBe(ID_A);
    expect(start.data.meta.formatVersion).toBe(1);
  });

  it("round-trips meta through readMeta", () => {
    const startedAt = "2026-03-04T10:00:00.000Z";
    store.createSession({ ...baseMeta(ID_A, startedAt), gitBranch: "feature/x" });

    expect(store.readMeta(ID_A)).toEqual({
      formatVersion: 1,
      id: ID_A,
      agent: "claude-code",
      command: ["claude", "--continue"],
      cwd: "/work/project",
      startedAt,
      gitBranch: "feature/x",
    });
  });

  it("refuses to create a session whose directory already exists", () => {
    store.createSession(baseMeta(ID_A));
    expect(() => store.createSession(baseMeta(ID_A))).toThrow(/already exists/);
  });

  it("generates ULID ids that sort by creation time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const earlier = store.newSessionId();
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
      const later = store.newSessionId();

      expect(earlier).toHaveLength(26);
      expect(later).toHaveLength(26);
      expect([later, earlier].sort()).toEqual([earlier, later]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns monotonic sequence numbers and non-negative timestamps", () => {
    const writer = store.createSession(baseMeta(ID_A));
    writer.event("prompt", { text: "first" });
    writer.event("turn.end", {});
    writer.event("notification", { message: "waiting" });

    const events = store.readEvents(ID_A);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    for (const event of events) {
      expect(event.t).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps elapsed time to zero when startedAt is in the future", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const writer = store.createSession(baseMeta(ID_A, future));
    writer.event("prompt", { text: "hello" });

    expect(eventAt(store.readEvents(ID_A), 1).t).toBe(0);
  });

  it("round-trips typed event data", () => {
    const writer = store.createSession(baseMeta(ID_A));
    writer.event("tool.start", {
      name: "Bash",
      input: { command: "pnpm test", timeout: 120_000 },
      toolUseId: "tu_01",
    });
    writer.event("usage", {
      model: "claude-fable-5",
      requestId: "req_01",
      usage: {
        inputTokens: 12,
        outputTokens: 340,
        cacheReadInputTokens: 8_000,
        cacheCreation5mInputTokens: 1_200,
        cacheCreation1hInputTokens: 400,
      },
    });
    writer.event("file.change", {
      path: "/work/project/src/a.ts",
      kind: "edit",
      diff: "-old\n+new",
    });

    const events = store.readEvents(ID_A);
    const toolStart = expectEvent(events, 1, "tool.start");
    expect(toolStart.data.name).toBe("Bash");
    expect(toolStart.data.input).toEqual({ command: "pnpm test", timeout: 120_000 });
    expect(toolStart.data.toolUseId).toBe("tu_01");

    const usage = expectEvent(events, 2, "usage");
    expect(usage.data.usage.cacheCreation1hInputTokens).toBe(400);
    expect(usage.data.requestId).toBe("req_01");

    const change = expectEvent(events, 3, "file.change");
    expect(change.data.kind).toBe("edit");
    expect(change.data.diff).toBe("-old\n+new");
  });

  it("skips a torn final line but keeps every complete event before it", () => {
    const writer = store.createSession(baseMeta(ID_A));
    writer.event("prompt", { text: "one" });
    writer.event("prompt", { text: "two" });
    appendFileSync(join(store.sessionDir(ID_A), EVENTS_FILE), '{"seq":3,"t":10,"type":"pro');

    const events = store.readEvents(ID_A);
    expect(events).toHaveLength(3);
    expect(expectEvent(events, 2, "prompt").data.text).toBe("two");
  });

  it("returns an empty event list when events.jsonl is absent", () => {
    mkdirSync(store.sessionDir(ID_A), { recursive: true });
    expect(store.readEvents(ID_A)).toEqual([]);
  });

  it("reads the cast file when present and null when absent", () => {
    store.createSession(baseMeta(ID_A));
    expect(store.readCast(ID_A)).toBeNull();
    writeFileSync(store.castPath(ID_A), '{"version":2,"width":80,"height":24}\n');
    expect(store.readCast(ID_A)).toContain('"version":2');
  });

  it("merges and persists meta updates", () => {
    const writer = store.createSession(baseMeta(ID_A));
    writer.updateMeta({ title: "Investigate flake" });
    writer.updateMeta({ agentSessionId: "0f4d2b1a-1111-2222-3333-444455556666" });

    const meta = store.readMeta(ID_A);
    expect(meta.title).toBe("Investigate flake");
    expect(meta.agentSessionId).toBe("0f4d2b1a-1111-2222-3333-444455556666");
    expect(meta.cwd).toBe("/work/project");
    expect(writer.sessionMeta.title).toBe("Investigate flake");
  });

  it("records session.end plus endedAt and exitCode on end", () => {
    const writer: SessionWriter = store.createSession(baseMeta(ID_A));
    writer.event("prompt", { text: "go" });
    writer.end(0);

    const events = store.readEvents(ID_A);
    const end = expectEvent(events, events.length - 1, "session.end");
    expect(end.data.exitCode).toBe(0);

    const meta = store.readMeta(ID_A);
    expect(meta.exitCode).toBe(0);
    expect(typeof meta.endedAt).toBe("string");
    expect(Number.isNaN(Date.parse(meta.endedAt ?? ""))).toBe(false);
  });

  it("records a null exit code for a killed process", () => {
    const writer = store.createSession(baseMeta(ID_A));
    writer.end(null);
    expect(store.readMeta(ID_A).exitCode).toBeNull();
  });

  it("resolves an exact session id", () => {
    store.createSession(baseMeta(ID_A));
    expect(store.resolveId(ID_A)).toBe(ID_A);
  });

  it("resolves an unambiguous case-insensitive prefix", () => {
    store.createSession(baseMeta(ID_A));
    store.createSession(baseMeta(ID_C));
    expect(store.resolveId("01testa")).toBe(ID_A);
    expect(store.resolveId("01zzzz")).toBe(ID_C);
  });

  it("throws when no session matches the prefix", () => {
    store.createSession(baseMeta(ID_A));
    expect(() => store.resolveId("01nope")).toThrow(/no session matching/);
  });

  it("throws when a prefix matches more than one session", () => {
    store.createSession(baseMeta(ID_A, "2026-03-04T10:00:00.000Z"));
    store.createSession(baseMeta(ID_B, "2026-03-04T11:00:00.000Z"));
    expect(() => store.resolveId("01test")).toThrow(/ambiguous session prefix/);
  });

  it("lists sessions newest first and skips corrupt session directories", () => {
    store.createSession(baseMeta(ID_A, "2026-03-04T10:00:00.000Z"));
    store.createSession(baseMeta(ID_C, "2026-03-05T09:30:00.000Z"));
    const corrupt = join(root, "sessions", "01BROKENAAAAAAAAAAAAAAAAAA");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, META_FILE), "{ this is not json");
    writeFileSync(join(root, "sessions", "stray.txt"), "ignore me");

    expect(store.list().map((meta) => meta.id)).toEqual([ID_C, ID_A]);
  });

  it("lists nothing when the store has never been used", () => {
    expect(new SessionStore(join(root, "missing")).list()).toEqual([]);
  });

  it("deletes a session directory", () => {
    store.createSession(baseMeta(ID_A));
    store.delete(ID_A);
    expect(store.has(ID_A)).toBe(false);
  });
});

describe("defaultStoreRoot", () => {
  it("honors AGENT_BLACKBOX_HOME", () => {
    expect(defaultStoreRoot({ AGENT_BLACKBOX_HOME: "/custom/blackbox" })).toBe("/custom/blackbox");
  });

  it("falls back to a directory under the home directory", () => {
    expect(defaultStoreRoot({})).toBe(join(homedir(), ".agent-blackbox"));
  });

  it("treats an empty override as unset", () => {
    expect(defaultStoreRoot({ AGENT_BLACKBOX_HOME: "" })).toBe(join(homedir(), ".agent-blackbox"));
  });
});
