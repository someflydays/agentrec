import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FORK_TOKEN_HEADER,
  type ForkPoint,
  type ForkPointsResponse,
  type ForkResponse,
  type SessionEvent,
  type SessionEventType,
  type SessionMeta,
  type SessionStore,
} from "@agentrec/core";
import { truncate } from "../format.js";
import { resolveTranscriptPath } from "../recorder/fork.js";
import { type ForkLauncher, ForkRequestError, launchFork } from "./fork-runner.js";
import { sendError, sendJson } from "./http.js";
import { hasForkToken } from "./security.js";

const PREVIEW_CHARS = 80;
const MAX_BODY_BYTES = 1024 * 1024;

/** What a fork can cut at: what the user asked, what the agent said, what it ran. */
const FORKABLE: ReadonlySet<SessionEventType> = new Set(["prompt", "assistant.text", "tool.start"]);

/** Ordered by how well the field identifies a call, as core's diff orders it. */
const TOOL_DETAIL_FIELDS = ["command", "file_path", "notebook_path", "path", "pattern", "url"];

function oneLine(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS);
}

function toolDetail(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const field of TOOL_DETAIL_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function previewOf(event: SessionEvent): string {
  switch (event.type) {
    case "prompt":
    case "assistant.text":
      return oneLine(event.data.text);
    case "tool.start": {
      const detail = toolDetail(event.data.input);
      return detail === null ? event.data.name : oneLine(`${event.data.name} ${detail}`);
    }
    default:
      return event.type;
  }
}

export function forkPointsOf(events: readonly SessionEvent[]): ForkPoint[] {
  const points: ForkPoint[] = [];
  for (const event of events) {
    if (!FORKABLE.has(event.type)) continue;
    points.push({ seq: event.seq, t: event.t, type: event.type, preview: previewOf(event) });
  }
  return points;
}

/**
 * Why this session cannot be forked, or null when its transcript is still on
 * disk. The Claude Code version check is left to the fork itself: it shells out,
 * and this route is read whenever a session is opened.
 */
function transcriptProblem(meta: SessionMeta): string | null {
  if (meta.agentSessionId === undefined) {
    return "this session was recorded without hooks, so it has no agent transcript to fork";
  }
  if (resolveTranscriptPath(meta) === null) {
    return `Claude Code no longer has a transcript for agent session ${meta.agentSessionId}`;
  }
  return null;
}

export function handleForkPoints(store: SessionStore, id: string, res: ServerResponse): void {
  // An imported session, or one whose transcript Claude Code has since removed,
  // is an ordinary state of the dashboard — not an error to report as one.
  const problem = transcriptProblem(store.readMeta(id));
  if (problem !== null) {
    const body: ForkPointsResponse = { points: [], available: false, reason: problem };
    sendJson(res, 200, body);
    return;
  }
  const body: ForkPointsResponse = {
    points: forkPointsOf(store.readEvents(id)),
    available: true,
  };
  sendJson(res, 200, body);
}

function isJsonBody(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return (contentType.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/** Resolves null when the body exceeded the limit; the request is drained either way. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("error", reject);
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(oversized ? null : Buffer.concat(chunks).toString("utf8"));
    });
  });
}

interface ForkInput {
  seq: number;
  prompt: string;
}

/** Narrows an untrusted body, or returns the message explaining why it cannot. */
function parseForkRequest(body: string): ForkInput | string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return "the fork body is not valid JSON";
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "the fork body must be a JSON object";
  }
  const { seq, prompt } = payload as Record<string, unknown>;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return "fork needs `seq`, the sequence number of the event to fork from";
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return "fork needs a non-empty `prompt`";
  }
  return { seq, prompt };
}

export type ForkHandler = (
  store: SessionStore,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

/**
 * Each fork spawns an agent that spends tokens and runs tools, so exactly one
 * runs per server at a time. `launch` is a parameter so the route can be
 * exercised without an agent.
 */
export function createForkHandler(launch: ForkLauncher = launchFork): ForkHandler {
  let running = false;

  return (store, id, req, res) => {
    if (!hasForkToken(req)) {
      sendError(res, 403, `fork needs the ${FORK_TOKEN_HEADER} header from /api/capabilities`);
      return;
    }
    if (!isJsonBody(req.headers["content-type"])) {
      sendError(res, 415, "fork expects a body of content-type application/json");
      return;
    }
    if (running) {
      sendError(res, 409, "a fork is already running; wait for it to finish");
      return;
    }

    void (async () => {
      try {
        const body = await readBody(req);
        if (body === null) {
          sendError(res, 413, `the fork body must be under ${MAX_BODY_BYTES} bytes`);
          return;
        }
        const input = parseForkRequest(body);
        if (typeof input === "string") {
          sendError(res, 400, input);
          return;
        }
        if (!forkPointsOf(store.readEvents(id)).some((point) => point.seq === input.seq)) {
          sendError(res, 400, `seq ${input.seq} is not one of this session's fork points`);
          return;
        }
        if (running) {
          sendError(res, 409, "a fork is already running; wait for it to finish");
          return;
        }

        running = true;
        let started: Awaited<ReturnType<ForkLauncher>>;
        try {
          started = await launch({ store, sessionId: id, seq: input.seq, prompt: input.prompt });
        } catch (error) {
          running = false;
          const status = error instanceof ForkRequestError ? error.status : 500;
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, status, status === 500 ? `could not start the fork: ${message}` : message);
          return;
        }

        // The agent keeps running past this response; the dashboard opens the
        // new session and follows it over the stream route.
        void started.done.then(
          () => {
            running = false;
          },
          () => {
            running = false;
          },
        );
        const responseBody: ForkResponse = { sessionId: started.sessionId };
        sendJson(res, 200, responseBody);
      } catch (error) {
        if (res.headersSent) return;
        sendError(res, 500, error instanceof Error ? error.message : String(error));
      }
    })();
  };
}
