import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type SessionWriter, TranscriptParser } from "@agent-blackbox/core";

/**
 * Claude Code appends to its JSONL transcript as it streams. Polling by size
 * beats fs.watch here: watch events are coalesced and platform-dependent, and
 * give no byte offset to resume from. The file may not exist yet when the first
 * hook fires, and is recreated on /clear — both show up as a size reset.
 */
const POLL_INTERVAL_MS = 400;

export class TranscriptTailer {
  private readonly path: string;
  private readonly writer: SessionWriter;
  private readonly parser = new TranscriptParser();
  private decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private offset = 0;
  private partial = "";

  constructor(path: string, writer: SessionWriter) {
    this.path = path;
    this.writer = writer;
  }

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL_MS);
    // Never keep the process alive past the recorded session.
    this.timer.unref();
  }

  /** Idempotent; the first call flushes whatever the agent wrote on its way out. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.poll();
  }

  private poll(): void {
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
      }
      if (size === this.offset) return;
      const length = size - this.offset;
      const buffer = Buffer.allocUnsafe(length);
      const fd = openSync(this.path, "r");
      try {
        const read = readSync(fd, buffer, 0, length, this.offset);
        this.offset += read;
        this.consume(this.decoder.write(buffer.subarray(0, read)));
      } finally {
        closeSync(fd);
      }
    } catch {
      // Not written yet, or a transient read error — retry on the next tick.
    }
  }

  private consume(text: string): void {
    if (text.length === 0) return;
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      for (const observation of this.parser.observe(line)) {
        switch (observation.kind) {
          case "assistant-text":
            this.writer.event("assistant.text", {
              text: observation.text,
              ...(observation.model !== undefined ? { model: observation.model } : {}),
              ...(observation.requestId !== undefined ? { requestId: observation.requestId } : {}),
            });
            break;
          case "usage":
            this.writer.event("usage", {
              model: observation.model,
              requestId: observation.requestId,
              usage: observation.usage,
            });
            break;
          case "title":
            this.writer.event("session.title", { title: observation.title });
            this.writer.updateMeta({ title: observation.title });
            break;
        }
      }
    }
  }
}
