import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SessionEvent,
  type SessionEventsResponse,
  SessionStore,
  type SessionWriter,
  type StreamMessage,
} from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestListener } from "../src/server/router.js";

const ID = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const CWD = "/tmp/agentrec-project";
/** The stream polls every 300ms, so waits have to outlast a few cycles. */
const WAIT_TIMEOUT_MS = 4000;
const SETTLE_MS = 800;
const FRAME_END = "\n\n";

let temp: string;
let store: SessionStore;
let server: Server | undefined;
let base: string;
let open: Subscription[] = [];

/** A session with session.start (seq 0) and a prompt (seq 1), still recording. */
function seedLive(id: string): SessionWriter {
  const writer = store.createSession({
    id,
    agent: "claude-code",
    command: ["claude"],
    cwd: CWD,
    startedAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
  });
  writer.event("prompt", { text: "add a retry to the uploader" });
  return writer;
}

async function start(): Promise<void> {
  const distDir = join(temp, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html><head><title>agentrec</title></head></html>");
  server = createServer(createRequestListener({ store, distDir }));
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

interface Subscription {
  messages: StreamMessage[];
  events: () => SessionEvent[];
  seqs: () => number[];
  ended: () => boolean;
  close: () => void;
}

/**
 * Resolves once the response headers are in, which the handler only flushes
 * after it has established its tail — so anything written afterwards is a
 * genuine append, not a race with the handshake.
 */
async function subscribe(query = ""): Promise<Subscription> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/${ID}/stream${query}`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const body = response.body;
  if (body === null) throw new Error("stream response had no body");

  const messages: StreamMessage[] = [];
  void collect(body, messages);
  const events = (): SessionEvent[] =>
    messages.flatMap((message) => (message.kind === "event" ? [message.event] : []));
  const subscription: Subscription = {
    messages,
    events,
    seqs: () => events().map((event) => event.seq),
    ended: () => messages.some((message) => message.kind === "end"),
    close: () => {
      controller.abort();
    },
  };
  open.push(subscription);
  return subscription;
}

async function collect(body: ReadableStream<Uint8Array>, messages: StreamMessage[]): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf(FRAME_END); end !== -1; end = buffer.indexOf(FRAME_END)) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + FRAME_END.length);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) messages.push(JSON.parse(data.slice(6)) as StreamMessage);
      }
    }
  } catch {
    // aborted by the test, or the server went away mid-frame
  }
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lastSeqFromFetch(): Promise<number> {
  const response = await fetch(`${base}/api/sessions/${ID}/events`);
  const body = (await response.json()) as SessionEventsResponse;
  return body.events[body.events.length - 1]?.seq ?? -1;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-stream-"));
  store = new SessionStore(join(temp, "home"));
  store.ensure();
  open = [];
});

afterEach(async () => {
  for (const subscription of open) subscription.close();
  open = [];
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
  rmSync(temp, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/stream", () => {
  it("replays an event written between the client's fetch and the subscription", async () => {
    const writer = seedLive(ID);
    await start();
    const lastSeq = await lastSeqFromFetch();
    expect(lastSeq).toBe(1);

    // The gap this route exists to close: on disk after the fetch answered,
    // before anything is tailing.
    writer.event("assistant.text", { text: "missed" });

    const stream = await subscribe(`?since-seq=${String(lastSeq)}`);
    await waitUntil(() => stream.seqs().length >= 1, "the replayed event");
    writer.event("assistant.text", { text: "tailed" });
    await waitUntil(() => stream.seqs().length >= 2, "the tailed event");
    writer.end(0);
    await waitUntil(() => stream.ended(), "the end message");

    expect(stream.seqs()).toEqual([2, 3, 4]);
    expect(textOf(stream.events()[0])).toBe("missed");
    expect(textOf(stream.events()[1])).toBe("tailed");
  });

  it("delivers nothing twice when the client missed nothing", async () => {
    const writer = seedLive(ID);
    await start();
    const lastSeq = await lastSeqFromFetch();

    const stream = await subscribe(`?since-seq=${String(lastSeq)}`);
    writer.event("assistant.text", { text: "after" });
    await waitUntil(() => stream.seqs().length >= 1, "the tailed event");
    // A duplicate would arrive on one of the next polls, not instantly.
    await delay(SETTLE_MS);

    expect(stream.seqs()).toEqual([2]);
  });

  it("tails from the end of the file when since-seq is absent", async () => {
    const writer = seedLive(ID);
    await start();

    const stream = await subscribe();
    writer.event("assistant.text", { text: "after" });
    await waitUntil(() => stream.seqs().length >= 1, "the tailed event");
    await delay(SETTLE_MS);

    expect(stream.seqs()).toEqual([2]);
  });

  it("replays what an ended session recorded after the fetch, then ends", async () => {
    const writer = seedLive(ID);
    await start();
    const lastSeq = await lastSeqFromFetch();
    writer.event("assistant.text", { text: "missed" });
    writer.end(0);

    const stream = await subscribe(`?since-seq=${String(lastSeq)}`);
    await waitUntil(() => stream.ended(), "the end message");

    expect(stream.seqs()).toEqual([2, 3]);
    expect(stream.messages.at(-1)).toEqual({ kind: "end", exitCode: 0 });
  });

  it("ends an already-ended session immediately when since-seq is absent", async () => {
    const writer = seedLive(ID);
    writer.end(0);
    await start();

    const stream = await subscribe();
    await waitUntil(() => stream.ended(), "the end message");

    expect(stream.messages).toEqual([{ kind: "end", exitCode: 0 }]);
  });

  it("rejects a since-seq that is not an integer", async () => {
    seedLive(ID);
    await start();
    const response = await fetch(`${base}/api/sessions/${ID}/stream?since-seq=nope`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("since-seq");
  });
});

function textOf(event: SessionEvent | undefined): string | undefined {
  return event?.type === "assistant.text" ? event.data.text : undefined;
}
