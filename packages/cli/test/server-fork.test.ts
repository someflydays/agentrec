import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORK_TOKEN_HEADER, type ForkResponse, SessionStore } from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForkLaunch, ForkLaunchRequest } from "../src/server/fork-runner.js";
import { createRequestListener, type RouterOptions } from "../src/server/router.js";
import { processToken } from "../src/server/security.js";

const SESSION_ID = "01DDDDDDDDDDDDDDDDDDDDDDDD";
const PROMPT_SEQ = 1;
const TOOL_END_SEQ = 3;

let temp: string;
let store: SessionStore;
let server: Server | undefined;
let base: string;
let launched: ForkLaunchRequest[];

/** Never resolves, so the concurrency gate stays shut for the whole test. */
function pendingLaunch(request: ForkLaunchRequest): Promise<ForkLaunch> {
  launched.push(request);
  return Promise.resolve({ sessionId: "01FORKFORKFORKFORKFORKFORK", done: new Promise(() => {}) });
}

async function start(options: Partial<RouterOptions> = {}): Promise<void> {
  const distDir = join(temp, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html><head></head></html>");
  server = createServer(createRequestListener({ store, distDir, ...options }));
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

function postFork(body: unknown, token: string | undefined): Promise<Response> {
  return fetch(`${base}/api/sessions/${SESSION_ID}/fork`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { [FORK_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-fork-route-"));
  launched = [];
  store = new SessionStore(join(temp, "home"));
  store.ensure();
  const writer = store.createSession({
    id: SESSION_ID,
    agent: "claude-code",
    command: ["claude"],
    cwd: "/tmp/agentrec-project",
    startedAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
  });
  writer.event("prompt", { text: "ship the uploader" });
  writer.event("tool.start", { name: "Bash", input: { command: "pnpm test" }, toolUseId: "t1" });
  writer.event("tool.end", { name: "Bash", ok: true, toolUseId: "t1" });
  writer.end(0);
});

afterEach(async () => {
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

describe("POST /api/sessions/:id/fork", () => {
  it("does not exist unless the server allows forking", async () => {
    await start();
    const response = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, processToken());

    expect(response.status).toBe(404);
    expect(launched).toHaveLength(0);
  });

  it("refuses a missing or wrong token", async () => {
    await start({ allowFork: true, launchFork: pendingLaunch });
    const none = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, undefined);
    const wrong = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, "0".repeat(64));

    expect(none.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(launched).toHaveLength(0);
  });

  it("rejects an empty prompt, a non-fork-point seq and a non-JSON body", async () => {
    await start({ allowFork: true, launchFork: pendingLaunch });
    const empty = await postFork({ seq: PROMPT_SEQ, prompt: "   " }, processToken());
    const badSeq = await postFork({ seq: TOOL_END_SEQ, prompt: "keep going" }, processToken());
    const notJson = await fetch(`${base}/api/sessions/${SESSION_ID}/fork`, {
      method: "POST",
      headers: { "content-type": "text/plain", [FORK_TOKEN_HEADER]: processToken() },
      body: "seq=1",
    });

    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("prompt");
    expect(badSeq.status).toBe(400);
    expect(await badSeq.text()).toContain("fork points");
    expect(notJson.status).toBe(415);
    expect(launched).toHaveLength(0);
  });

  it("launches the fork and answers with the new session id", async () => {
    await start({ allowFork: true, launchFork: pendingLaunch });
    const response = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, processToken());
    const body = (await response.json()) as ForkResponse;

    expect(response.status).toBe(200);
    expect(body.sessionId).toBe("01FORKFORKFORKFORKFORKFORK");
    expect(launched).toEqual([
      { store, sessionId: SESSION_ID, seq: PROMPT_SEQ, prompt: "keep going" },
    ]);
  });

  it("runs one fork at a time", async () => {
    await start({ allowFork: true, launchFork: pendingLaunch });
    const first = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, processToken());
    const second = await postFork({ seq: PROMPT_SEQ, prompt: "again" }, processToken());

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(launched).toHaveLength(1);
  });

  it("reports a launch failure with its own status", async () => {
    const { ForkRequestError } = await import("../src/server/fork-runner.js");
    await start({
      allowFork: true,
      launchFork: () => Promise.reject(new ForkRequestError(400, "no transcript on disk")),
    });
    const response = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, processToken());

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no transcript on disk");
  });

  it("answers 500 when the launch fails for another reason", async () => {
    await start({
      allowFork: true,
      launchFork: () => Promise.reject(new Error("claude exploded")),
    });
    const response = await postFork({ seq: PROMPT_SEQ, prompt: "keep going" }, processToken());

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("claude exploded");
  });
});
