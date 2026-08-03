import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCast } from "../src/cast-format.js";
import { SessionStore } from "../src/session-store.js";
import { summarizeSession } from "../src/summary.js";
import { SESSION_FORMAT_VERSION } from "../src/types.js";
import { expectEvent, firstOfType } from "./helpers.js";

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const FIXTURE_ID = "01JDEM0FAKESESS10N000000FX";

const store = new SessionStore(FIXTURES_ROOT);

describe("demo fixture", () => {
  it("is the only session in the fixture store", () => {
    expect(store.list().map((meta) => meta.id)).toEqual([FIXTURE_ID]);
    expect(store.resolveId("01jdem0")).toBe(FIXTURE_ID);
  });

  it("has a session id of valid ULID shape", () => {
    expect(FIXTURE_ID).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("parses meta.json as a complete SessionMeta", () => {
    const meta = store.readMeta(FIXTURE_ID);

    expect(meta.formatVersion).toBe(SESSION_FORMAT_VERSION);
    expect(meta.id).toBe(FIXTURE_ID);
    expect(meta.agent).toBe("claude-code");
    expect(meta.command).toEqual(["claude"]);
    expect(meta.cwd).toBe("/home/dev/circuitsim");
    expect(meta.startedAt).toBe("2026-08-01T17:03:12.000Z");
    expect(meta.endedAt).toBe("2026-08-01T17:12:27.000Z");
    expect(meta.exitCode).toBe(0);
    expect(meta.title).toBe("Fix flaky watchdog test in circuitsim");
    expect(meta.gitBranch).toBe("main");
    expect(meta.agentSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("reads every event with monotonic sequence numbers and timestamps", () => {
    const events = store.readEvents(FIXTURE_ID);

    expect(events.length).toBeGreaterThanOrEqual(35);
    events.forEach((event, index) => {
      expect(event.seq).toBe(index);
      expect(event.t).toBeGreaterThanOrEqual(index === 0 ? 0 : (events[index - 1]?.t ?? 0));
    });
  });

  it("opens with session.start and closes with session.end", () => {
    const events = store.readEvents(FIXTURE_ID);
    const meta = store.readMeta(FIXTURE_ID);

    const start = expectEvent(events, 0, "session.start");
    expect(start.data.meta.id).toBe(FIXTURE_ID);
    expect(start.data.meta.startedAt).toBe(meta.startedAt);

    const end = expectEvent(events, events.length - 1, "session.end");
    expect(end.data.exitCode).toBe(meta.exitCode);
    expect(end.data.exitCode).toBe(0);
  });

  it("keeps every event inside the recorded session window", () => {
    const meta = store.readMeta(FIXTURE_ID);
    const durationMs = Date.parse(meta.endedAt ?? "") - Date.parse(meta.startedAt);

    for (const event of store.readEvents(FIXTURE_ID)) {
      expect(event.t).toBeLessThanOrEqual(durationMs);
    }
  });

  it("pairs each tool.start with a tool.end", () => {
    const events = store.readEvents(FIXTURE_ID);
    const starts = events.filter((event) => event.type === "tool.start").length;
    const ends = events.filter((event) => event.type === "tool.end").length;

    expect(starts).toBeGreaterThan(0);
    expect(ends).toBe(starts);
  });

  it("summarizes into a session worth looking at", () => {
    const summary = summarizeSession(store.readMeta(FIXTURE_ID), store.readEvents(FIXTURE_ID));

    expect(summary.prompts).toBeGreaterThan(0);
    expect(summary.toolCalls).toBeGreaterThan(0);
    expect(Object.keys(summary.toolCounts).length).toBeGreaterThan(1);
    expect(summary.filesChanged.length).toBeGreaterThan(0);
    expect(summary.durationMs).toBe(555_000);
    expect(summary.title).toBe("Fix flaky watchdog test in circuitsim");
  });

  it("prices a realistic two-model mix", () => {
    const summary = summarizeSession(store.readMeta(FIXTURE_ID), store.readEvents(FIXTURE_ID));

    expect(summary.models.map((model) => model.model).sort()).toEqual([
      "claude-fable-5",
      "claude-opus-5",
    ]);
    for (const model of summary.models) {
      expect(model.requests).toBeGreaterThan(0);
      expect(model.costUsd).toBeGreaterThan(0);
    }
    expect(summary.totalCostUsd).not.toBeNull();
    expect(summary.totalCostUsd ?? 0).toBeGreaterThan(0);
    expect(summary.totalUsage.cacheReadInputTokens).toBeGreaterThan(0);
    expect(summary.totalUsage.cacheCreation5mInputTokens).toBeGreaterThan(0);
    expect(summary.totalUsage.cacheCreation1hInputTokens).toBeGreaterThan(0);
  });

  it("records a file change whose diff reads like a real patch", () => {
    const change = firstOfType(store.readEvents(FIXTURE_ID), "file.change");

    expect(change.data.path.startsWith("/home/dev/circuitsim/")).toBe(true);
    expect(change.data.kind).toBe("edit");
    expect(change.data.diff).toMatch(/^@@ /);
  });

  it("parses terminal.cast as an asciinema v2 recording", () => {
    const text = store.readCast(FIXTURE_ID);
    expect(text).not.toBeNull();

    const { header, events } = parseCast(text ?? "");
    expect(header.version).toBe(2);
    expect(header.width).toBe(120);
    expect(header.height).toBe(32);
    expect(header.timestamp).toBe(Date.parse("2026-08-01T17:03:12.000Z") / 1000);

    expect(events.length).toBeGreaterThanOrEqual(25);
    expect(events.some((event) => event.code === "r")).toBe(true);
    expect(events.filter((event) => event.code === "o").length).toBeGreaterThanOrEqual(24);
    for (const [index, event] of events.entries()) {
      expect(event.t).toBeGreaterThanOrEqual(events[index - 1]?.t ?? 0);
    }
  });

  it("styles the cast output with ANSI escape sequences", () => {
    const { events } = parseCast(store.readCast(FIXTURE_ID) ?? "");
    const output = events
      .filter((event) => event.code === "o")
      .map((event) => event.data)
      .join("");

    expect(output).toContain("\u001b[31m");
    expect(output).toContain("\u001b[32m");
    expect(output).toContain("\u001b[2m");
  });

  it("aligns the cast timeline with the event timeline", () => {
    const events = store.readEvents(FIXTURE_ID);
    const { events: castEvents } = parseCast(store.readCast(FIXTURE_ID) ?? "");
    const lastEventSeconds = (events[events.length - 1]?.t ?? 0) / 1000;
    const lastCastSeconds = castEvents[castEvents.length - 1]?.t ?? 0;

    expect(lastCastSeconds).toBeLessThanOrEqual(lastEventSeconds);
    expect(lastCastSeconds).toBeGreaterThan(lastEventSeconds * 0.9);
  });
});
