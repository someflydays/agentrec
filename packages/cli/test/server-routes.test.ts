import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilitiesResponse,
  type DiffResponse,
  type ForkPointsResponse,
  type SearchResponse,
  SessionStore,
} from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestListener, type RouterOptions } from "../src/server/router.js";
import { processToken } from "../src/server/security.js";
import { TOKEN_META_NAME } from "../src/server/static.js";

const ID_A = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01BBBBBBBBBBBBBBBBBBBBBBBB";
const AGENT_SESSION = "33333333-3333-4333-8333-333333333333";
const CWD = "/tmp/agentrec-project";
const LONG_PROMPT =
  "add a retry to the uploader so that a transient network failure does not lose the batch, and log every attempt";

let temp: string;
let store: SessionStore;
let server: Server | undefined;
let base: string;
let previousConfigDir: string | undefined;

interface SeedOptions {
  prompt: string;
  command: string;
  reply: string;
  agentSessionId?: string;
}

function seed(id: string, options: SeedOptions): void {
  const writer = store.createSession({
    id,
    agent: "claude-code",
    command: ["claude"],
    cwd: CWD,
    startedAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
    ...(options.agentSessionId !== undefined ? { agentSessionId: options.agentSessionId } : {}),
  });
  writer.event("prompt", { text: options.prompt });
  writer.event("tool.start", {
    name: "Bash",
    input: { command: options.command },
    toolUseId: "t1",
  });
  writer.event("tool.end", { name: "Bash", ok: true, toolUseId: "t1" });
  writer.event("assistant.text", { text: options.reply });
  writer.end(0);
}

/** Puts a transcript where the fork module looks for one. */
function seedTranscript(agentSessionId: string): void {
  const dir = join(temp, "claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentSessionId}.jsonl`), "");
}

async function start(options: Partial<RouterOptions> = {}): Promise<void> {
  const distDir = join(temp, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html><head><title>agentrec</title></head></html>");
  server = createServer(createRequestListener({ store, distDir, ...options }));
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-server-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(temp, "claude");
  store = new SessionStore(join(temp, "home"));
  store.ensure();
  seed(ID_A, { prompt: LONG_PROMPT, command: "pnpm test", reply: "I added a retry loop" });
  seed(ID_B, { prompt: LONG_PROMPT, command: "pnpm build", reply: "nothing to retry here" });
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
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  rmSync(temp, { recursive: true, force: true });
});

describe("GET /api/search", () => {
  it("returns hits for a query and echoes it back", async () => {
    await start();
    const response = await fetch(`${base}/api/search?q=retry`);
    const body = (await response.json()) as SearchResponse;

    expect(response.status).toBe(200);
    expect(body.query).toBe("retry");
    expect(body.results.length).toBeGreaterThan(1);
    expect(new Set(body.results.map((result) => result.sessionId))).toEqual(new Set([ID_A, ID_B]));
  });

  it("respects limit, session and type", async () => {
    await start();
    const limited = (await (
      await fetch(`${base}/api/search?q=retry&limit=1`)
    ).json()) as SearchResponse;
    const scoped = (await (
      await fetch(`${base}/api/search?q=retry&session=${ID_A}`)
    ).json()) as SearchResponse;
    const typed = (await (
      await fetch(`${base}/api/search?q=retry&type=prompt`)
    ).json()) as SearchResponse;

    expect(limited.results).toHaveLength(1);
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(scoped.results.every((result) => result.sessionId === ID_A)).toBe(true);
    expect(typed.results.length).toBeGreaterThan(0);
    expect(typed.results.every((result) => result.type === "prompt")).toBe(true);
  });

  it("answers an empty query with an empty result set", async () => {
    await start();
    const missing = await fetch(`${base}/api/search`);
    const empty = await fetch(`${base}/api/search?q=`);

    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ results: [], query: "" });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ results: [], query: "" });
  });

  it("rejects an invalid limit and an unknown session", async () => {
    await start();
    const badLimit = await fetch(`${base}/api/search?q=retry&limit=nope`);
    const unknown = await fetch(`${base}/api/search?q=retry&session=nosuchsession`);

    expect(badLimit.status).toBe(400);
    expect(await badLimit.text()).toContain("positive integer");
    expect(unknown.status).toBe(404);
  });
});

describe("GET /api/diff", () => {
  it("diffs two sessions", async () => {
    await start();
    const response = await fetch(`${base}/api/diff?a=${ID_A}&b=${ID_B}`);
    const body = (await response.json()) as DiffResponse;

    expect(response.status).toBe(200);
    expect(body.diff.a.id).toBe(ID_A);
    expect(body.diff.b.id).toBe(ID_B);
    expect(body.diff.identical).toBe(false);
    expect(body.diff.totals.commands.onlyA).toEqual(["pnpm test"]);
  });

  it("needs both sides and known ids", async () => {
    await start();
    const missing = await fetch(`${base}/api/diff?a=${ID_A}`);
    const unknown = await fetch(`${base}/api/diff?a=${ID_A}&b=nosuchsession`);

    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("both");
    expect(unknown.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/fork-points", () => {
  it("reports unavailable with 200 when there is no transcript", async () => {
    await start();
    const response = await fetch(`${base}/api/sessions/${ID_A}/fork-points`);
    const body = (await response.json()) as ForkPointsResponse;

    expect(response.status).toBe(200);
    expect(body).toEqual({ points: [], available: false, reason: expect.any(String) });
  });

  it("lists prompts, replies and tool calls with one-line previews", async () => {
    const id = "01CCCCCCCCCCCCCCCCCCCCCCCC";
    seed(id, {
      prompt: LONG_PROMPT,
      command: "pnpm test",
      reply: "I added\na retry loop",
      agentSessionId: AGENT_SESSION,
    });
    seedTranscript(AGENT_SESSION);
    await start();

    const response = await fetch(`${base}/api/sessions/${id}/fork-points`);
    const body = (await response.json()) as ForkPointsResponse;

    expect(response.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.points.map((point) => point.type)).toEqual([
      "prompt",
      "tool.start",
      "assistant.text",
    ]);
    expect(body.points[0]?.preview).toBe(`${LONG_PROMPT.slice(0, 80)}…`);
    expect(body.points[1]?.preview).toBe("Bash pnpm test");
    expect(body.points[2]?.preview).toBe("I added a retry loop");
    expect(body.points.every((point) => typeof point.t === "number")).toBe(true);
  });
});

describe("GET /api/capabilities", () => {
  it("reports forking off by default with a stable token", async () => {
    await start();
    const first = (await (await fetch(`${base}/api/capabilities`)).json()) as CapabilitiesResponse;
    const second = (await (await fetch(`${base}/api/capabilities`)).json()) as CapabilitiesResponse;

    expect(first.fork).toBe(false);
    expect(first.token).toHaveLength(64);
    expect(second.token).toBe(first.token);
    expect(first.token).toBe(processToken());
  });

  it("reports forking on when the server allows it", async () => {
    await start({ allowFork: true });
    const body = (await (await fetch(`${base}/api/capabilities`)).json()) as CapabilitiesResponse;

    expect(body.fork).toBe(true);
  });
});

describe("static assets", () => {
  it("hands the token to the page it serves", async () => {
    await start();
    const response = await fetch(`${base}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<meta name="${TOKEN_META_NAME}" content="${processToken()}">`);
  });
});
