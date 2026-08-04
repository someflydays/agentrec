import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEvent, SessionStore, type SessionWriter } from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planFork, plannedUuids, type TranscriptLine } from "../src/recorder/fork.js";
import { TranscriptTailer } from "../src/recorder/transcript-tailer.js";

const SESSION_ID = "01TTTTTTTTTTTTTTTTTTTTTTTT";

let temp: string;
let store: SessionStore;
let writer: SessionWriter;

function assistantLine(uuid: string, text: string, requestId: string): TranscriptLine {
  return {
    uuid,
    parentUuid: null,
    type: "assistant",
    requestId,
    sessionId: "11111111-1111-4111-8111-111111111111",
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function lineOf(uuid: string, parentUuid: string | null): TranscriptLine {
  return { uuid, parentUuid, type: "user", message: { role: "user", content: "hi" } };
}

/** The tailer only consumes whole lines, so the file always ends in a newline. */
function writeTranscript(lines: TranscriptLine[]): string {
  const path = join(temp, "transcript.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/** stop() flushes whatever is on disk, so no polling interval has to elapse. */
function tail(path: string, skipUuids?: ReadonlySet<string>): SessionEvent[] {
  const tailer = new TranscriptTailer(path, writer, skipUuids === undefined ? {} : { skipUuids });
  tailer.stop();
  return store.readEvents(SESSION_ID);
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-tailer-"));
  store = new SessionStore(join(temp, "home"));
  store.ensure();
  writer = store.createSession({
    id: SESSION_ID,
    agent: "claude-code",
    command: ["claude"],
    cwd: temp,
    startedAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
  });
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("TranscriptTailer", () => {
  const lines = [
    assistantLine("inherited-1", "the parent said this", "req_parent_1"),
    assistantLine("inherited-2", "and then this", "req_parent_2"),
    assistantLine("fresh-1", "the fork says this", "req_child_1"),
  ];

  it("records the text and usage of every line when nothing is skipped", () => {
    const events = tail(writeTranscript(lines));

    expect(events.filter((event) => event.type === "assistant.text")).toHaveLength(3);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
  });

  it("ignores the text and usage of inherited lines, and records the rest", () => {
    const events = tail(writeTranscript(lines), new Set(["inherited-1", "inherited-2"]));

    const texts = events.filter((event) => event.type === "assistant.text");
    const usage = events.filter((event) => event.type === "usage");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.data).toMatchObject({
      text: "the fork says this",
      transcriptUuid: "fresh-1",
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.data).toMatchObject({ requestId: "req_child_1" });
  });

  it("still stamps the session title, which no uuid can identify", () => {
    const path = writeTranscript([{ type: "ai-title", aiTitle: "wire up the uploader" }, ...lines]);
    const events = tail(path, new Set(["inherited-1", "inherited-2", "fresh-1"]));

    expect(events.filter((event) => event.type === "session.title")).toHaveLength(1);
    expect(store.readMeta(SESSION_ID).title).toBe("wire up the uploader");
    expect(events.filter((event) => event.type === "assistant.text")).toHaveLength(0);
  });

  it("skips exactly the lines a fork plan carried over", () => {
    const plan = planFork(lines, { at: 1, newSessionId: "22222222-2222-4222-8222-222222222222" });
    const skip = plannedUuids(plan.lines);

    expect(skip).toEqual(new Set(["inherited-1", "inherited-2"]));
    const events = tail(writeTranscript(lines), skip);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });
});

describe("plannedUuids", () => {
  it("collects the conversation lines only, ignoring metadata without a uuid", () => {
    const withMetadata: TranscriptLine[] = [
      lineOf("u1", null),
      { type: "last-prompt", lastPrompt: "hi", leafUuid: "u1" },
      lineOf("a1", "u1"),
      { uuid: "", parentUuid: "a1", type: "user" },
    ];

    expect(plannedUuids(withMetadata)).toEqual(new Set(["u1", "a1"]));
    expect(plannedUuids([])).toEqual(new Set());
  });
});
