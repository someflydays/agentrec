import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type SessionWriter, TranscriptParser } from "@agentrec/core";
import { asNonEmptyString, asRecord } from "./json.js";

/**
 * Claude Code appends to its JSONL transcript as it streams. Polling by size
 * beats fs.watch here: watch events are coalesced and platform-dependent, and
 * give no byte offset to resume from. The file may not exist yet when the first
 * hook fires, and is recreated on /clear — both show up as a size reset.
 */
const POLL_INTERVAL_MS = 400;

/**
 * Conversation lines carry a `uuid` that Claude Code chains through
 * `parentUuid`; it is the only stable identity of a line, since the file is
 * rewritten on compaction and byte offsets do not survive that. Stamping it on
 * the events read from a line lets `agentrec fork` cut at that exact line.
 */
function lineUuid(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return asNonEmptyString(asRecord(parsed)?.uuid);
}

export interface TranscriptTailerOptions {
  /**
   * uuids of transcript lines this session did not produce. A resumed
   * conversation (every fork, and `--resume`/`--continue`) starts from a
   * transcript that already holds its parent's turns, and tailing replays the
   * file from the beginning: without this the parent's replies and token spend
   * would be recorded a second time, against the child.
   */
  skipUuids?: ReadonlySet<string>;
}

export class TranscriptTailer {
  private readonly path: string;
  private readonly writer: SessionWriter;
  private readonly skipUuids: ReadonlySet<string> | undefined;
  private readonly parser = new TranscriptParser();
  private decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private offset = 0;
  private partial = "";

  constructor(path: string, writer: SessionWriter, options: TranscriptTailerOptions = {}) {
    this.path = path;
    this.writer = writer;
    this.skipUuids = options.skipUuids;
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
    for (const line of lines) this.consumeLine(line);
  }

  private consumeLine(line: string): void {
    // Without a skip set, only lines that carried something worth recording are
    // parsed a second time for their uuid; with one, every line is.
    const known = this.skipUuids === undefined ? undefined : lineUuid(line);
    if (known !== undefined && this.skipUuids?.has(known) === true) {
      // Still parsed, so the parser's per-request usage dedup keeps matching
      // the file, but nothing an inherited line says belongs to this session.
      this.parser.observe(line);
      return;
    }

    const observations = this.parser.observe(line);
    if (observations.length === 0) return;
    const uuid = known ?? lineUuid(line);
    const from = uuid !== undefined ? { transcriptUuid: uuid } : {};
    for (const observation of observations) {
      switch (observation.kind) {
        case "assistant-text":
          this.writer.event("assistant.text", {
            text: observation.text,
            ...(observation.model !== undefined ? { model: observation.model } : {}),
            ...(observation.requestId !== undefined ? { requestId: observation.requestId } : {}),
            ...from,
          });
          break;
        case "usage":
          this.writer.event("usage", {
            model: observation.model,
            requestId: observation.requestId,
            usage: observation.usage,
            ...from,
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
