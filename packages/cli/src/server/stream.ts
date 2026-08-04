import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import {
  EVENTS_FILE,
  type SessionEvent,
  type SessionMeta,
  type SessionStore,
  type StreamMessage,
} from "@agentrec/core";
import { sendError } from "./http.js";

/**
 * The recorder appends to events.jsonl and terminal.cast from a separate
 * process, so fs.watch gives us no useful payload — we poll sizes and read the
 * delta. 300ms is imperceptible for follow-along and costs two stat calls.
 */
const POLL_INTERVAL_MS = 300;

const LINE_FEED = 0x0a;

/** Highest event seq the client already holds; everything after it is replayed. */
const SINCE_SEQ_PARAM = "since-seq";

/** Yields whole lines appended to a growing file, tolerating torn writes. */
class LineTailer {
  private readonly path: string;
  private offset: number;
  private pending: Buffer;

  /**
   * Starts at the current end of file, so only future appends are emitted.
   * `fromStart` instead begins at byte 0: the first poll returns everything on
   * disk and leaves the offset exactly where that read stopped, so replay and
   * tail share one boundary.
   */
  constructor(path: string, fromStart = false) {
    this.path = path;
    this.offset = fromStart || !existsSync(path) ? 0 : statSync(path).size;
    this.pending = Buffer.alloc(0);
  }

  poll(): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    if (size === this.offset) return [];

    const buffer = Buffer.allocUnsafe(size - this.offset);
    const fd = openSync(this.path, "r");
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.byteLength, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += read;

    // Decode only complete lines — a trailing partial line can split a
    // multi-byte UTF-8 sequence, which would decode as replacement chars.
    const combined = Buffer.concat([this.pending, buffer.subarray(0, read)]);
    const lastBreak = combined.lastIndexOf(LINE_FEED);
    if (lastBreak === -1) {
      this.pending = combined;
      return [];
    }
    this.pending = combined.subarray(lastBreak + 1);
    return combined
      .subarray(0, lastBreak)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  }
}

/**
 * Follows a session. With `?since-seq=<n>` the events already on disk past seq
 * `n` are replayed before tailing starts, which closes the window between the
 * client's `/events` fetch and this subscription.
 *
 * Cast frames carry no seq, so that channel is always tailed from the current
 * end of file: terminal output written during the same window is not recovered.
 */
export function handleSessionStream(
  store: SessionStore,
  id: string,
  params: URLSearchParams,
  res: ServerResponse,
): void {
  const raw = params.get(SINCE_SEQ_PARAM);
  const since = parseSinceSeq(raw);
  if (since === INVALID) {
    sendError(res, 400, `invalid ${SINCE_SEQ_PARAM} "${raw ?? ""}" — expected an integer`);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Node holds headers back until the first frame; without this a subscriber to
  // a quiet session is not considered connected until something happens to it.
  res.flushHeaders();

  const send = (message: StreamMessage): void => {
    res.write(`event: ${message.kind}\ndata: ${JSON.stringify(message)}\n\n`);
  };

  // Meta is read before the replay so nothing can be dropped at the far end
  // either: the recorder writes session.end and only then stamps endedAt, so a
  // session that ends after this read has its last event on disk already.
  const initial = readMeta(store, id);
  const events = new LineTailer(join(store.sessionDir(id), EVENTS_FILE), since !== null);
  if (since !== null) {
    for (const event of pollEvents(events)) {
      if (event.seq > since) send({ kind: "event", event });
    }
  }

  if (initial === null || initial.endedAt !== undefined) {
    send({ kind: "end", exitCode: initial?.exitCode ?? null });
    res.end();
    return;
  }

  const cast = new LineTailer(store.castPath(id));

  // Tailing resumes from the byte the replay stopped at, so an event appended
  // while the request was in flight lands in exactly one of the two.
  const drain = (): void => {
    for (const event of pollEvents(events)) {
      send({ kind: "event", event });
    }
    for (const line of cast.poll()) {
      send({ kind: "cast", line });
    }
  };

  const timer = setInterval(() => {
    drain();
    const meta = readMeta(store, id);
    if (meta !== null && meta.endedAt === undefined) return;
    // Flush anything the recorder wrote between the last drain and shutdown.
    drain();
    send({ kind: "end", exitCode: meta?.exitCode ?? null });
    clearInterval(timer);
    res.end();
  }, POLL_INTERVAL_MS);

  res.on("close", () => {
    clearInterval(timer);
  });
}

const INVALID = "invalid";

function parseSinceSeq(raw: string | null): number | null | typeof INVALID {
  if (raw === null || raw.length === 0) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : INVALID;
}

function pollEvents(tailer: LineTailer): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of tailer.poll()) {
    const event = parseEvent(line);
    if (event !== null) events.push(event);
  }
  return events;
}

function parseEvent(line: string): SessionEvent | null {
  try {
    return JSON.parse(line) as SessionEvent;
  } catch {
    return null;
  }
}

function readMeta(store: SessionStore, id: string): SessionMeta | null {
  try {
    return store.readMeta(id);
  } catch {
    return null;
  }
}
