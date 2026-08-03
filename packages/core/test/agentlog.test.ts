import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTLOG_EXTENSION,
  AGENTLOG_VERSION,
  type AgentlogBundle,
  exportSession,
  importBundle,
  importFile,
  packBundle,
  unpackBundle,
} from "../src/agentlog.js";
import { SessionStore } from "../src/session-store.js";
import type { SessionEvent, SessionMeta } from "../src/types.js";
import { expectEvent, makeEvent, makeTempDir, removeTempDir } from "./helpers.js";

const ID = "01LOGAAAAAAAAAAAAAAAAAAAAA";
const STARTED_AT = "2026-08-01T17:03:12.000Z";

const CAST_TEXT = [
  '{"version":2,"width":120,"height":32,"timestamp":1785949392,"title":"demo"}',
  '[0.000000, "o", "\\u001b[1mAgent Black Box\\u001b[0m\\r\\n"]',
  '[1.500000, "r", "120x32"]',
  "",
].join("\n");

function sampleMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    formatVersion: 1,
    id: ID,
    agent: "claude-code",
    command: ["claude", "--continue"],
    cwd: "/home/dev/circuitsim",
    startedAt: STARTED_AT,
    endedAt: "2026-08-01T17:12:27.000Z",
    exitCode: 0,
    title: "Fix flaky watchdog test",
    gitBranch: "main",
    ...overrides,
  };
}

function sampleEvents(meta: SessionMeta): SessionEvent[] {
  return [
    makeEvent(0, 0, "session.start", { meta }),
    makeEvent(1, 1_200, "prompt", { text: "the watchdog test is flaky" }),
    makeEvent(2, 3_400, "tool.start", {
      name: "Bash",
      input: { command: "pnpm vitest run" },
      toolUseId: "tu_01",
    }),
    makeEvent(3, 9_900, "tool.end", { name: "Bash", ok: true, output: "20 passed" }),
    makeEvent(4, 10_400, "usage", {
      model: "claude-fable-5",
      requestId: "req_01",
      usage: {
        inputTokens: 5,
        outputTokens: 312,
        cacheReadInputTokens: 24_610,
        cacheCreation5mInputTokens: 1_842,
        cacheCreation1hInputTokens: 0,
      },
    }),
    makeEvent(5, 11_000, "session.end", { exitCode: 0 }),
  ];
}

describe("packBundle and unpackBundle", () => {
  it("round-trips meta, events, and cast through gzip", () => {
    const meta = sampleMeta();
    const events = sampleEvents(meta);
    const bundle = unpackBundle(packBundle({ meta, events, cast: CAST_TEXT }));

    expect(bundle.format).toBe("agentlog");
    expect(bundle.version).toBe(AGENTLOG_VERSION);
    expect(bundle.meta).toEqual(meta);
    expect(bundle.events).toEqual(events);
    expect(bundle.cast).toBe(CAST_TEXT);
  });

  it("preserves a null cast for sessions recorded without a terminal", () => {
    const meta = sampleMeta();
    expect(unpackBundle(packBundle({ meta, events: [], cast: null })).cast).toBeNull();
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    const meta = sampleMeta();
    const packed = packBundle({ meta, events: [], cast: null });
    expect(unpackBundle(new Uint8Array(packed)).meta.id).toBe(ID);
  });

  it("rejects data that is not gzip", () => {
    expect(() => unpackBundle(Buffer.from("this is plainly not gzip", "utf8"))).toThrow(
      /gunzip failed/,
    );
  });

  it("rejects a bundle with an unexpected format field", () => {
    const packed = gzipSync(
      Buffer.from(JSON.stringify({ format: "something-else", version: 1 }), "utf8"),
    );
    expect(() => unpackBundle(packed)).toThrow(/unexpected format field/);
  });

  it("rejects a bundle from a future format version", () => {
    const packed = gzipSync(
      Buffer.from(JSON.stringify({ format: "agentlog", version: 2 }), "utf8"),
    );
    expect(() => unpackBundle(packed)).toThrow(/unsupported \.agentlog version 2/);
  });

  it("names the canonical file extension", () => {
    expect(AGENTLOG_EXTENSION).toBe(".agentlog");
  });
});

describe("exportSession and importFile", () => {
  let sourceRoot: string;
  let targetRoot: string;
  let source: SessionStore;
  let target: SessionStore;
  let exportPath: string;

  beforeEach(() => {
    sourceRoot = makeTempDir();
    targetRoot = makeTempDir();
    source = new SessionStore(sourceRoot);
    target = new SessionStore(targetRoot);
    exportPath = join(sourceRoot, `session${AGENTLOG_EXTENSION}`);

    const writer = source.createSession({
      id: ID,
      agent: "claude-code",
      command: ["claude", "--continue"],
      cwd: "/home/dev/circuitsim",
      startedAt: STARTED_AT,
      gitBranch: "main",
    });
    writer.event("prompt", { text: "the watchdog test is flaky" });
    writer.event("tool.start", { name: "Bash", input: { command: "pnpm vitest run" } });
    writer.event("tool.end", { name: "Bash", ok: true, output: "20 passed" });
    writer.updateMeta({ title: "Fix flaky watchdog test" });
    writeFileSync(writer.castPath, CAST_TEXT);
    writer.end(0);
  });

  afterEach(() => {
    removeTempDir(sourceRoot);
    removeTempDir(targetRoot);
  });

  it("moves a whole session into a second store", () => {
    exportSession(source, ID, exportPath);
    expect(importFile(target, exportPath)).toBe(ID);

    expect(target.readMeta(ID)).toEqual(source.readMeta(ID));
    expect(target.readEvents(ID)).toEqual(source.readEvents(ID));
    expect(target.readCast(ID)).toBe(CAST_TEXT);

    const events = target.readEvents(ID);
    expect(events).toHaveLength(5);
    expect(expectEvent(events, 0, "session.start").data.meta.id).toBe(ID);
    expect(expectEvent(events, 4, "session.end").data.exitCode).toBe(0);
  });

  it("writes a file that unpacks to the exported session", () => {
    exportSession(source, ID, exportPath);
    const bundle = unpackBundle(readFileSync(exportPath));

    expect(bundle.meta.title).toBe("Fix flaky watchdog test");
    expect(bundle.cast).toBe(CAST_TEXT);
  });

  it("refuses to import over an existing session id", () => {
    exportSession(source, ID, exportPath);
    importFile(target, exportPath);
    expect(() => importFile(target, exportPath)).toThrow(/already exists/);
  });

  it("replaces an existing session when overwrite is requested", () => {
    exportSession(source, ID, exportPath);
    importFile(target, exportPath);

    const replacement: AgentlogBundle = {
      format: "agentlog",
      version: AGENTLOG_VERSION,
      meta: sampleMeta({ title: "Replaced session" }),
      events: [makeEvent(0, 0, "prompt", { text: "only event" })],
      cast: null,
    };
    expect(importBundle(target, replacement, { overwrite: true })).toBe(ID);

    expect(target.readMeta(ID).title).toBe("Replaced session");
    expect(target.readEvents(ID)).toHaveLength(1);
    expect(target.readCast(ID)).toBeNull();
  });

  it("imports a session with no events at all", () => {
    const empty: AgentlogBundle = {
      format: "agentlog",
      version: AGENTLOG_VERSION,
      meta: sampleMeta({ id: "01LOGBBBBBBBBBBBBBBBBBBBBB" }),
      events: [],
      cast: null,
    };
    const id = importBundle(target, empty);

    expect(target.readEvents(id)).toEqual([]);
    expect(target.has(id)).toBe(true);
  });

  it("refuses to import a bundle whose id could escape the store directory", () => {
    for (const id of ["../../../tmp/x", "a/b", "..", ".", "", "a".repeat(65), "-leading"]) {
      const malicious: AgentlogBundle = {
        format: "agentlog",
        version: AGENTLOG_VERSION,
        meta: sampleMeta({ id }),
        events: [],
        cast: null,
      };
      expect(() => importBundle(target, malicious)).toThrowError(/unsafe session id/);
    }
  });
});
