import { createWriteStream, type WriteStream } from "node:fs";
import type { CastHeader } from "./cast-format.js";

/**
 * Only output ("o") and resize ("r") events are written. Raw terminal input
 * is deliberately never recorded: keystrokes can contain secrets that are not
 * echoed to the screen.
 */
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
