import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRecordedSession } from "../src/recorder/session-runner.js";

const CLI_ENTRY = "/opt/agentrec/dist/index.js";

let temp: string;
let store: SessionStore;

/** node stands in for the agent: it is on PATH wherever the tests run. */
function nodeCommand(script: string): string[] {
  return [process.execPath, "-e", script];
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-runner-"));
  store = new SessionStore(join(temp, "home"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("startRecordedSession", () => {
  it("records a headless run from its meta through to its exit code", async () => {
    const session = await startRecordedSession({
      store,
      command: nodeCommand("process.stdout.write('hello from the agent')"),
      cwd: temp,
      mode: "headless",
      cliEntry: CLI_ENTRY,
      gitBranch: "main",
      forkedFrom: { sessionId: "01PARENTPARENTPARENTPARENT", seq: 4 },
    });
    const exitCode = await session.done;

    expect(exitCode).toBe(0);
    const meta = store.readMeta(session.id);
    expect(meta.forkedFrom).toEqual({ sessionId: "01PARENTPARENTPARENTPARENT", seq: 4 });
    expect(meta.gitBranch).toBe("main");
    expect(meta.exitCode).toBe(0);
    expect(meta.endedAt).toBeDefined();

    const events = store.readEvents(session.id);
    expect(events[0]?.type).toBe("session.start");
    expect(events.at(-1)).toMatchObject({ type: "session.end", data: { exitCode: 0 } });

    const cast = readFileSync(store.castPath(session.id), "utf8").split("\n");
    expect(JSON.parse(cast[0] ?? "")).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(cast[1]).toContain("hello from the agent");
  });

  it("hands over the agent's exit code and reaches the ingest endpoint", async () => {
    const script = [
      "const url = process.env.AGENTREC_INGEST_URL;",
      "const token = process.env.AGENTREC_INGEST_TOKEN;",
      "fetch(url, {",
      "  method: 'POST',",
      "  headers: { authorization: 'Bearer ' + token },",
      "  body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' }),",
      "}).then(() => process.exit(3));",
    ].join("");
    const session = await startRecordedSession({
      store,
      command: nodeCommand(script),
      cwd: temp,
      mode: "headless",
      cliEntry: CLI_ENTRY,
    });

    expect(await session.done).toBe(3);
    const events = store.readEvents(session.id);
    expect(events.filter((event) => event.type === "prompt")).toMatchObject([
      { data: { text: "ship it" } },
    ]);
  });

  it("closes the recording and reports why when the agent cannot be run", async () => {
    const session = await startRecordedSession({
      store,
      command: [join(temp, "no-such-agent")],
      cwd: temp,
      mode: "headless",
      cliEntry: CLI_ENTRY,
    });

    await expect(session.done).rejects.toThrow(/ENOENT/);
    const events = store.readEvents(session.id);
    expect(events.some((event) => event.type === "recorder.error")).toBe(true);
    expect(store.readMeta(session.id).exitCode).toBe(null);
  });

  it("leaves a command that is not claude exactly as it was asked for", async () => {
    const session = await startRecordedSession({
      store,
      command: nodeCommand("process.stdout.write(process.argv.join(' '))"),
      cwd: temp,
      mode: "headless",
      cliEntry: CLI_ENTRY,
    });
    await session.done;

    const cast = readFileSync(store.castPath(session.id), "utf8");
    expect(cast).not.toContain("--settings");
    expect(store.readMeta(session.id).command).toEqual(
      nodeCommand("process.stdout.write(process.argv.join(' '))"),
    );
  });
});
