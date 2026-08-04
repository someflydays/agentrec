import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENTS_FILE,
  type SessionDetailResponse,
  type SessionListResponse,
  SessionStore,
  type SessionWriter,
} from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestListener } from "../src/server/router.js";

const ID_A = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01BBBBBBBBBBBBBBBBBBBBBBBB";
const ID_LIVE = "01CCCCCCCCCCCCCCCCCCCCCCCC";
const CWD = "/tmp/agentrec-project";

let temp: string;
let store: SessionStore;
let server: Server | undefined;
let base: string;

function newWriter(id: string): SessionWriter {
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

function seedEnded(id: string): void {
  const writer = newWriter(id);
  writer.event("assistant.text", { text: "I added a retry loop" });
  writer.end(0);
}

/** Appends behind the store's back, the way a recorder in another process does. */
function appendPrompt(id: string, seq: number): void {
  const record = { seq, t: 1000, type: "prompt", data: { text: "and log every attempt" } };
  appendFileSync(join(store.sessionDir(id), EVENTS_FILE), `${JSON.stringify(record)}\n`);
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

async function list(): Promise<SessionListResponse> {
  const response = await fetch(`${base}/api/sessions`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionListResponse;
}

function promptsOf(body: SessionListResponse, id: string): number | undefined {
  return body.sessions.find((session) => session.id === id)?.prompts;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-cache-"));
  store = new SessionStore(join(temp, "home"));
  store.ensure();
  seedEnded(ID_A);
  seedEnded(ID_B);
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("session summary cache", () => {
  it("does not re-read events when nothing on disk changed", async () => {
    await start();
    const reads = vi.spyOn(store, "readEvents");

    const first = await list();
    expect(reads).toHaveBeenCalledTimes(2);
    const second = await list();

    expect(reads).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it("serves the detail route from the same cache", async () => {
    await start();
    const reads = vi.spyOn(store, "readEvents");

    const listed = await list();
    const response = await fetch(`${base}/api/sessions/${ID_A}`);
    const detail = (await response.json()) as SessionDetailResponse;

    expect(reads).toHaveBeenCalledTimes(2);
    expect(detail.summary).toEqual(listed.sessions.find((session) => session.id === ID_A));
  });

  it("re-summarizes only the session whose events changed", async () => {
    await start();
    const reads = vi.spyOn(store, "readEvents");
    const before = await list();

    appendPrompt(ID_A, 4);
    const after = await list();

    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads).toHaveBeenLastCalledWith(ID_A);
    expect(promptsOf(after, ID_A)).toBe((promptsOf(before, ID_A) ?? 0) + 1);
    expect(promptsOf(after, ID_B)).toBe(promptsOf(before, ID_B));
  });

  it("keeps a growing live session current while its ended neighbours stay cached", async () => {
    const writer = newWriter(ID_LIVE);
    await start();
    const reads = vi.spyOn(store, "readEvents");
    await list();

    writer.event("prompt", { text: "and log every attempt" });
    const after = await list();

    // The list order is the store's business; what matters is how often each
    // session's events were parsed.
    const readIds = reads.mock.calls.map((call) => call[0]);
    expect(readIds.filter((id) => id === ID_LIVE)).toHaveLength(2);
    expect(readIds.filter((id) => id === ID_A)).toHaveLength(1);
    expect(readIds.filter((id) => id === ID_B)).toHaveLength(1);
    expect(promptsOf(after, ID_LIVE)).toBe(2);
  });

  it("drops a session that was deleted from disk", async () => {
    await start();
    await list();

    store.delete(ID_B);
    const after = await list();

    expect(after.sessions.map((session) => session.id)).toEqual([ID_A]);
  });
});
