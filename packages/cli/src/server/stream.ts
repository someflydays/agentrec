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

/**
 * The recorder appends to events.jsonl and terminal.cast from a separate
 * process, so fs.watch gives us no useful payload — we poll sizes and read the
 * delta. 300ms is imperceptible for follow-along and costs two stat calls.
 */
const POLL_INTERVAL_MS = 300;

const LINE_FEED = 0x0a;

/** Yields whole lines appended to a growing file, tolerating torn writes. */
class LineTailer {
  private readonly path: string;
  private offset: number;
  private pending: Buffer;

  /** Starts at the current end of file: only future appends are emitted. */
  constructor(path: string) {
    this.path = path;
    this.offset = existsSync(path) ? statSync(path).size : 0;
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

export function handleSessionStream(store: SessionStore, id: string, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const send = (message: StreamMessage): void => {
    res.write(`event: ${message.kind}\ndata: ${JSON.stringify(message)}\n\n`);
  };

  const initial = readMeta(store, id);
  if (initial === null || initial.endedAt !== undefined) {
    send({ kind: "end", exitCode: initial?.exitCode ?? null });
    res.end();
    return;
  }

  const events = new LineTailer(join(store.sessionDir(id), EVENTS_FILE));
  const cast = new LineTailer(store.castPath(id));

  const drain = (): void => {
    for (const line of events.poll()) {
      const event = parseEvent(line);
      if (event !== null) send({ kind: "event", event });
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
