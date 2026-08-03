import { createWriteStream, type WriteStream } from "node:fs";

/**
 * Terminal recordings use the asciinema v2 format (asciicast): a JSON header
 * line followed by one JSON array per event. Sessions stay playable with
 * standard asciinema tooling, not just our dashboard.
 *
 * Only output ("o") and resize ("r") events are written. Raw terminal input
 * is deliberately never recorded: keystrokes can contain secrets that are not
 * echoed to the screen.
 */
export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
  env?: Record<string, string>;
}

export interface CastEvent {
  /** Seconds since recording start. */
  t: number;
  code: "o" | "i" | "r" | "m";
  data: string;
}

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
}

function eventLine(tMs: number, code: string, data: string): string {
  const seconds = (tMs / 1000).toFixed(6);
  return `[${seconds}, ${JSON.stringify(code)}, ${JSON.stringify(data)}]\n`;
}

export class CastWriter {
  private readonly stream: WriteStream;
  private closed = false;

  constructor(
    path: string,
    options: {
      width: number;
      height: number;
      title?: string;
      env?: Record<string, string>;
      timestamp?: number;
    },
  ) {
    this.stream = createWriteStream(path, { flags: "w" });
    const header: CastHeader = {
      version: 2,
      width: options.width,
      height: options.height,
      ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    };
    this.stream.write(`${JSON.stringify(header)}\n`);
  }

  output(tMs: number, data: string): void {
    if (this.closed) return;
    this.stream.write(eventLine(tMs, "o", data));
  }

  resize(tMs: number, cols: number, rows: number): void {
    if (this.closed) return;
    this.stream.write(eventLine(tMs, "r", `${cols}x${rows}`));
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

/** Tolerant parser: malformed lines are skipped, matching SessionStore.readEvents. */
export function parseCast(text: string): Cast {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new Error("empty cast file");
  }
  const header = JSON.parse(headerLine) as CastHeader;
  if (header.version !== 2) {
    throw new Error(`unsupported cast version: ${String(header.version)}`);
  }
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line) as [number, CastEvent["code"], string];
      if (typeof parsed[0] === "number" && typeof parsed[2] === "string") {
        events.push({ t: parsed[0], code: parsed[1], data: parsed[2] });
      }
    } catch {
      // torn write — skip
    }
  }
  return { header, events };
}
