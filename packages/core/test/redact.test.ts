import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTLOG_EXTENSION,
  AGENTLOG_VERSION,
  type AgentlogBundle,
  packBundle,
  unpackBundle,
} from "../src/agentlog.js";
import { parseCast } from "../src/cast-format.js";
import {
  DEFAULT_PATTERNS,
  HIGH_ENTROPY_NAME,
  type RedactionPattern,
  redactBundle,
  redactText,
} from "../src/redact.js";
import { SessionStore } from "../src/session-store.js";
import type { SessionEvent, SessionMeta } from "../src/types.js";
import { expectEvent, makeEvent, makeTempDir, removeTempDir } from "./helpers.js";

const ANTHROPIC_KEY = "sk-ant-api03-8Fj2kLmQ9xYz4Vb7Nc1Rd6Te0Wg5Ah3SpKqUvXyZ2LmNoPqRsTuVwXyZ0Ab";
const ID = "01JDEM0FAKESESS10N000000FX";
const AGENT_SESSION_ID = "b7f4c2a1-9e33-4d18-8a5c-6f0e21d4b7a9";

const CREDENTIALS: { label: string; secret: string }[] = [
  { label: "anthropic-api-key", secret: ANTHROPIC_KEY },
  { label: "openai-api-key", secret: "sk-proj-9aKd8Lm2Nq4Pr6Ts8Vw0Xy2Zb4Cd6Ef8Gh0Ij" },
  { label: "aws-access-key-id", secret: "AKIAIOSFODNN7EXAMPLE" },
  { label: "github-token", secret: "ghp_16C7e42F292c6912E7710c838347Ae178B4a" },
  { label: "google-api-key", secret: "AIzaSyC8f2kLmQ9xYz4Vb7Nc1Rd6Te0Wg5Ah3Sp" },
  { label: "slack-token", secret: "xoxb-2431780500-2431780512-Ad7Kq9LmXyZ4Vb7Nc1Rd6Te" },
  {
    label: "jwt",
    secret:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  },
  { label: HIGH_ENTROPY_NAME, secret: "npm_aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z12" },
];

/** Strings this data is full of that must survive a redaction pass intact. */
const KEEP = [
  ID,
  AGENT_SESSION_ID,
  "9f2c1d4e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "/home/dev/circuitsim/packages/core/src/session-store.ts",
  "https://github.com/someflydays/agentrec/blob/main/docs/format.md",
  "background: #a1b2c3;",
  "req_011CQr8xVYd2ZfN3TmKpWq7A",
  "MY_LONG_CONSTANT_NAME_123",
  "getUserAuthenticationTokenFromStore",
  "supercalifragilisticexpialidocious",
  "VGhpcyBpcyBqdXN0IHNvbWUgcGxhaW4gRW5nbGlzaCB0ZXh0IGVuY29kZWQ=",
  "sha512-ZBQ7Nq5JXBHXhxDBhVYaAcMWRNPRFPnHSFErdCqBHZKQ==",
  "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript",
  "tokens: 4231 input, 18400 cache read",
  "Tokens: 1,234,567",
];

const CAST_HEADER =
  '{"version":2,"width":120,"height":32,"timestamp":1785603792,"title":"claude - circuitsim","env":{"SHELL":"/bin/zsh","TERM":"xterm-256color"}}';

function sampleMeta(): SessionMeta {
  return {
    formatVersion: 1,
    id: ID,
    agent: "claude-code",
    command: ["claude", "--api-key", ANTHROPIC_KEY],
    cwd: "/home/dev/circuitsim",
    startedAt: "2026-08-01T17:03:12.000Z",
    endedAt: "2026-08-01T17:12:27.000Z",
    exitCode: 0,
    title: "Wire up the API_KEY=sk-ant-api03-QqZz9xYv2Nm4Bb7Cc1Dd8 client",
    agentSessionId: AGENT_SESSION_ID,
    gitBranch: "main",
  };
}

function sampleEvents(meta: SessionMeta): SessionEvent[] {
  return [
    makeEvent(0, 0, "session.start", { meta }),
    makeEvent(1, 1_100, "terminal.resize", { cols: 120, rows: 32 }),
    makeEvent(2, 7_800, "prompt", { text: `use ${ANTHROPIC_KEY} for the smoke test` }),
    makeEvent(3, 9_400, "usage", {
      model: "claude-fable-5",
      requestId: "req_011CQr8xVYd2ZfN3TmKpWq7A",
      usage: {
        inputTokens: 4,
        outputTokens: 312,
        cacheReadInputTokens: 0,
        cacheCreation5mInputTokens: 6_210,
        cacheCreation1hInputTokens: 18_400,
      },
    }),
    makeEvent(4, 9_600, "assistant.text", {
      text: `I will export ${ANTHROPIC_KEY} first.`,
      model: "claude-fable-5",
    }),
    makeEvent(5, 12_000, "tool.start", {
      name: "Bash",
      input: {
        command: `curl -H "Authorization: Bearer ${ANTHROPIC_KEY}" https://api.example.com`,
        timeout: 120_000,
        sandbox: false,
        env: [
          { name: "AWS_ACCESS_KEY_ID", value: "AKIAIOSFODNN7EXAMPLE" },
          { name: "HOME", value: "/home/dev" },
        ],
        empty: null,
      },
      toolUseId: "tu_01",
    }),
    makeEvent(6, 15_000, "tool.end", {
      name: "Bash",
      ok: true,
      output: `token ghp_16C7e42F292c6912E7710c838347Ae178B4a accepted`,
    }),
    makeEvent(7, 16_000, "file.change", {
      path: "src/client.ts",
      kind: "edit",
      diff: `+const key = "${ANTHROPIC_KEY}";`,
    }),
    makeEvent(8, 17_000, "notification", { message: `key ${ANTHROPIC_KEY} is invalid` }),
    makeEvent(9, 18_000, "session.title", { title: `Rotate ${ANTHROPIC_KEY}` }),
    makeEvent(10, 19_000, "session.end", { exitCode: 0 }),
  ];
}

function sampleCast(): string {
  return [
    CAST_HEADER,
    '[0.412000, "o", "\\u001b[2J\\u001b[H"]',
    `[1.250000, "o", "export ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\\r\\n"]`,
    '[2.500000, "r", "120x32"]',
    "",
  ].join("\n");
}

function sampleBundle(): AgentlogBundle {
  const meta = sampleMeta();
  return {
    format: "agentlog",
    version: AGENTLOG_VERSION,
    meta,
    events: sampleEvents(meta),
    cast: sampleCast(),
  };
}

describe("redactText", () => {
  it("labels each credential shape with the pattern that matched it", () => {
    for (const { label, secret } of CREDENTIALS) {
      const { text, counts } = redactText(`called with ${secret} at 12:04`);
      expect(text, label).toBe(`called with [REDACTED:${label}] at 12:04`);
      expect(counts[label], label).toBe(1);
    }
  });

  it("keeps the key name of an assignment and replaces only the value", () => {
    expect(redactText("GITHUB_TOKEN=aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z").text).toBe(
      "GITHUB_TOKEN=[REDACTED:secret-assignment]",
    );
    expect(redactText("export DATABASE_PASSWORD=hunter2swordfish").text).toBe(
      "export DATABASE_PASSWORD=[REDACTED:secret-assignment]",
    );
    expect(redactText('"api_key": "9aKd8Lm2Nq4Pr6Ts8Vw0Xy2Zb"').text).toBe(
      '"api_key": [REDACTED:secret-assignment]',
    );
  });

  it("keeps the aws key name and the Authorization scheme readable", () => {
    expect(redactText("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").text).toBe(
      "AWS_SECRET_ACCESS_KEY=[REDACTED:aws-secret-access-key]",
    );
    expect(redactText("Authorization: Bearer 9aKd8Lm2Nq4Pr6Ts8Vw0Xy2Zb4Cd").text).toBe(
      "Authorization: Bearer [REDACTED:authorization-header]",
    );
  });

  it("replaces a whole PEM block across lines", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA2Qv8xK3mLpQ9zYv4Nb7Cc1Rd6Te0Wg5Ah3SpKqUvXyZ2LmNo",
      "PqRsTuVwXyZ0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnop",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, counts } = redactText(`wrote key:\n${pem}\ndone`);

    expect(text).toBe("wrote key:\n[REDACTED:private-key]\ndone");
    expect(counts["private-key"]).toBe(1);
  });

  it("prefers the specific pattern over the generic assignment", () => {
    const { text, counts } = redactText(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`);
    expect(text).toBe("ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]");
    expect(counts["secret-assignment"]).toBeUndefined();
  });

  it("leaves ids, hashes, paths, urls and identifiers alone", () => {
    for (const sample of KEEP) {
      const { text, counts } = redactText(sample);
      expect(text, sample).toBe(sample);
      expect(counts, sample).toEqual({});
    }
  });

  it("counts every hit per pattern", () => {
    const { text, counts } = redactText(
      `${ANTHROPIC_KEY} then ${ANTHROPIC_KEY} then ghp_16C7e42F292c6912E7710c838347Ae178B4a`,
    );
    expect(counts).toEqual({ "anthropic-api-key": 2, "github-token": 1 });
    expect(text).toBe(
      "[REDACTED:anthropic-api-key] then [REDACTED:anthropic-api-key] then [REDACTED:github-token]",
    );
  });

  it("is idempotent: a second pass changes nothing and counts nothing", () => {
    const samples = [
      `key ${ANTHROPIC_KEY} here`,
      "GITHUB_TOKEN=aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z",
      "Authorization: Bearer 9aKd8Lm2Nq4Pr6Ts8Vw0Xy2Zb4Cd",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "npm_aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z12",
    ];
    for (const sample of samples) {
      const once = redactText(sample);
      const twice = redactText(once.text);
      expect(twice.text, sample).toBe(once.text);
      expect(twice.counts, sample).toEqual({});
    }
  });

  it("gives the same answer every call despite global patterns", () => {
    const input = `a ${ANTHROPIC_KEY} b`;
    const first = redactText(input);
    const second = redactText(input);
    const third = redactText(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("accepts a caller-supplied pattern set, including a non-global regex", () => {
    const patterns: RedactionPattern[] = [{ name: "ticket", pattern: /CIRC-\d+/ }];
    const { text, counts } = redactText("see CIRC-412 and CIRC-908", {
      patterns,
      entropy: false,
    });
    expect(text).toBe("see [REDACTED:ticket] and [REDACTED:ticket]");
    expect(counts).toEqual({ ticket: 2 });
  });

  it("skips the entropy heuristic when it is switched off", () => {
    const token = "npm_aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z12";
    expect(redactText(token, { entropy: false }).text).toBe(token);
    expect(redactText(token, { entropy: { minLength: 64 } }).text).toBe(token);
  });

  it("returns the empty string untouched", () => {
    expect(redactText("")).toEqual({ text: "", counts: {} });
  });

  it("leaves text with nothing to redact byte-identical", () => {
    const text = "the watchdog test is flaky about one run in five";
    expect(redactText(text).text).toBe(text);
  });
});

describe("redactBundle", () => {
  it("does not mutate the bundle it was given", () => {
    const bundle = sampleBundle();
    const before = structuredClone(bundle);
    redactBundle(bundle);
    expect(bundle).toEqual(before);
  });

  it("scrubs meta, keeping the session id and structural fields", () => {
    const { bundle } = redactBundle(sampleBundle());

    expect(bundle.meta.id).toBe(ID);
    expect(bundle.meta.agentSessionId).toBe(AGENT_SESSION_ID);
    expect(bundle.meta.cwd).toBe("/home/dev/circuitsim");
    expect(bundle.meta.command).toEqual(["claude", "--api-key", "[REDACTED:anthropic-api-key]"]);
    expect(bundle.meta.title).toBe("Wire up the API_KEY=[REDACTED:anthropic-api-key] client");
    expect(bundle.meta.formatVersion).toBe(1);
    expect(bundle.meta.exitCode).toBe(0);
  });

  it("scrubs every text-bearing event channel", () => {
    const { bundle } = redactBundle(sampleBundle());
    const events = bundle.events;

    expect(expectEvent(events, 0, "session.start").data.meta.title).not.toContain(ANTHROPIC_KEY);
    expect(expectEvent(events, 2, "prompt").data.text).toBe(
      "use [REDACTED:anthropic-api-key] for the smoke test",
    );
    expect(expectEvent(events, 4, "assistant.text").data.text).toBe(
      "I will export [REDACTED:anthropic-api-key] first.",
    );
    expect(expectEvent(events, 6, "tool.end").data.output).toBe(
      "token [REDACTED:github-token] accepted",
    );
    expect(expectEvent(events, 7, "file.change").data.diff).toBe(
      '+const key = "[REDACTED:anthropic-api-key]";',
    );
    expect(expectEvent(events, 8, "notification").data.message).toBe(
      "key [REDACTED:anthropic-api-key] is invalid",
    );
    expect(expectEvent(events, 9, "session.title").data.title).toBe(
      "Rotate [REDACTED:anthropic-api-key]",
    );
  });

  it("walks nested objects and arrays inside a tool input", () => {
    const { bundle } = redactBundle(sampleBundle());
    const input = expectEvent(bundle.events, 5, "tool.start").data.input as {
      command: string;
      timeout: number;
      sandbox: boolean;
      env: { name: string; value: string }[];
      empty: null;
    };

    expect(input.command).toBe(
      'curl -H "Authorization: Bearer [REDACTED:anthropic-api-key]" https://api.example.com',
    );
    expect(input.env[1]).toEqual({ name: "HOME", value: "/home/dev" });
    expect(input.env[0]?.value).toBe("[REDACTED:aws-access-key-id]");
    expect(input.env[0]?.name).toBe("AWS_ACCESS_KEY_ID");
    expect(input.timeout).toBe(120_000);
    expect(input.sandbox).toBe(false);
    expect(input.empty).toBeNull();
  });

  it("leaves numeric and structural event fields untouched", () => {
    const { bundle } = redactBundle(sampleBundle());

    const usage = expectEvent(bundle.events, 3, "usage");
    expect(usage.data.usage).toEqual({
      inputTokens: 4,
      outputTokens: 312,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 6_210,
      cacheCreation1hInputTokens: 18_400,
    });
    expect(usage.data.requestId).toBe("req_011CQr8xVYd2ZfN3TmKpWq7A");
    expect(usage.data.model).toBe("claude-fable-5");

    expect(expectEvent(bundle.events, 1, "terminal.resize").data).toEqual({ cols: 120, rows: 32 });
    expect(bundle.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(expectEvent(bundle.events, 5, "tool.start").data.toolUseId).toBe("tu_01");
    expect(expectEvent(bundle.events, 7, "file.change").data.path).toBe("src/client.ts");
  });

  it("keeps the cast parseable, with timings and codes unchanged", () => {
    const { bundle } = redactBundle(sampleBundle());
    expect(bundle.cast).not.toBeNull();
    const cast = parseCast(bundle.cast ?? "");

    expect(cast.header).toEqual(parseCast(sampleCast()).header);
    expect(cast.events.map((event) => event.t)).toEqual([0.412, 1.25, 2.5]);
    expect(cast.events.map((event) => event.code)).toEqual(["o", "o", "r"]);
    expect(cast.events[0]?.data).toBe("\u001b[2J\u001b[H");
    expect(cast.events[1]?.data).toBe("export ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]\r\n");
    expect(cast.events[2]?.data).toBe("120x32");

    const lines = (bundle.cast ?? "").split("\n");
    expect(lines[0]).toBe(CAST_HEADER);
    expect(lines[2]?.startsWith('[1.250000, "o", ')).toBe(true);
    expect(lines[4]).toBe("");
  });

  it("scrubs the cast header title and env values", () => {
    const header = `{"version":2,"width":80,"height":24,"title":"deploy ${ANTHROPIC_KEY}","env":{"TERM":"xterm-256color","API_TOKEN":"aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"}}`;
    const { bundle, summary } = redactBundle({
      ...sampleBundle(),
      cast: `${header}\n[0.100000, "o", "hi"]\n`,
    });
    const cast = parseCast(bundle.cast ?? "");

    expect(cast.header.title).toBe("deploy [REDACTED:anthropic-api-key]");
    expect(cast.header.env?.TERM).toBe("xterm-256color");
    expect(cast.header.env?.API_TOKEN).toBe("[REDACTED:high-entropy]");
    expect(cast.header.width).toBe(80);
    expect(cast.header.height).toBe(24);
    expect(summary.channels.cast).toBe(2);
  });

  it("handles a bundle with no cast and one with an empty cast", () => {
    const none = redactBundle({ ...sampleBundle(), cast: null });
    expect(none.bundle.cast).toBeNull();
    expect(none.summary.channels.cast).toBe(0);

    const empty = redactBundle({ ...sampleBundle(), cast: "" });
    expect(empty.bundle.cast).toBe("");
  });

  it("reports totals per pattern and per channel", () => {
    const { summary } = redactBundle(sampleBundle());

    expect(summary.byPattern["anthropic-api-key"]).toBe(11);
    expect(summary.byPattern["github-token"]).toBe(1);
    expect(summary.byPattern["aws-access-key-id"]).toBe(1);
    expect(summary.channels.meta).toBe(2);
    expect(summary.channels.cast).toBe(1);
    expect(summary.channels.events).toBe(10);
    expect(summary.totalReplacements).toBe(
      summary.channels.meta + summary.channels.events + summary.channels.cast,
    );
    expect(summary.totalReplacements).toBe(
      Object.values(summary.byPattern).reduce((sum, count) => sum + count, 0),
    );
  });

  it("reports nothing for a bundle with no secrets in it", () => {
    const meta = sampleMeta();
    const clean: AgentlogBundle = {
      format: "agentlog",
      version: AGENTLOG_VERSION,
      meta: { ...meta, command: ["claude"], title: "Fix flaky watchdog test" },
      events: [makeEvent(0, 0, "prompt", { text: "the watchdog test is flaky" })],
      cast: `{"version":2,"width":80,"height":24}\n[0.100000, "o", "20 passed"]\n`,
    };
    const { bundle, summary } = redactBundle(clean);

    expect(summary).toEqual({
      totalReplacements: 0,
      byPattern: {},
      channels: { cast: 0, events: 0, meta: 0 },
    });
    expect(bundle).toEqual(clean);
  });

  it("passes options through to every channel", () => {
    const patterns: RedactionPattern[] = [{ name: "cwd", pattern: /circuitsim/g }];
    const { bundle, summary } = redactBundle(sampleBundle(), { patterns, entropy: false });

    expect(bundle.meta.cwd).toBe("/home/dev/[REDACTED:cwd]");
    expect(bundle.meta.command).toEqual(["claude", "--api-key", ANTHROPIC_KEY]);
    expect(summary.byPattern).toEqual({ cwd: 3 });
  });
});

describe("DEFAULT_PATTERNS", () => {
  it("names every pattern uniquely", () => {
    const names = DEFAULT_PATTERNS.map((pattern) => pattern.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("redacted export round trip", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(root);
  });

  it("packs a redacted store session with the secret gone from every channel", () => {
    const store = new SessionStore(root);
    const writer = store.createSession({
      id: ID,
      agent: "claude-code",
      command: ["claude"],
      cwd: "/home/dev/circuitsim",
      startedAt: "2026-08-01T17:03:12.000Z",
    });
    writer.event("prompt", { text: `deploy with ${ANTHROPIC_KEY}` });
    writer.event("tool.end", { name: "Bash", ok: true, output: `echo ${ANTHROPIC_KEY}` });
    writeFileSync(
      writer.castPath,
      `{"version":2,"width":80,"height":24}\n[0.100000, "o", "${ANTHROPIC_KEY}"]\n`,
    );
    writer.end(0);

    const { bundle, summary } = redactBundle({
      format: "agentlog",
      version: AGENTLOG_VERSION,
      meta: store.readMeta(ID),
      events: store.readEvents(ID),
      cast: store.readCast(ID),
    });
    const outPath = join(root, `redacted${AGENTLOG_EXTENSION}`);
    writeFileSync(outPath, packBundle(bundle));

    const unpacked = unpackBundle(readFileSync(outPath));
    expect(JSON.stringify(unpacked)).not.toContain(ANTHROPIC_KEY);
    expect(unpacked.meta.id).toBe(ID);
    expect(unpacked.cast).toContain("[REDACTED:anthropic-api-key]");
    expect(summary.totalReplacements).toBe(3);

    // The stored session keeps its secrets: redaction touches the copy only.
    expect(
      store
        .readEvents(ID)
        .map((event) => JSON.stringify(event))
        .join(""),
    ).toContain(ANTHROPIC_KEY);
  });
});
