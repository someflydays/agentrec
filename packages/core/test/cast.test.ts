import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CastWriter } from "../src/cast.js";
import { type CastEvent, parseCast } from "../src/cast-format.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

function castEventAt(events: CastEvent[], index: number): CastEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`no cast event at index ${index} (length ${events.length})`);
  }
  return event;
}

describe("CastWriter", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = makeTempDir();
    path = join(dir, "terminal.cast");
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it("writes a v2 header carrying the terminal geometry and metadata", async () => {
    const writer = new CastWriter(path, {
      width: 120,
      height: 32,
      title: "demo",
      timestamp: 1_780_000_000,
      env: { TERM: "xterm-256color" },
    });
    await writer.close();

    const { header, events } = parseCast(readFileSync(path, "utf8"));
    expect(header).toEqual({
      version: 2,
      width: 120,
      height: 32,
      timestamp: 1_780_000_000,
      title: "demo",
      env: { TERM: "xterm-256color" },
    });
    expect(events).toEqual([]);
  });

  it("omits optional header fields that were not supplied", async () => {
    const writer = new CastWriter(path, { width: 80, height: 24 });
    await writer.close();

    expect(parseCast(readFileSync(path, "utf8")).header).toEqual({
      version: 2,
      width: 80,
      height: 24,
    });
  });

  it("round-trips output and resize events through parseCast", async () => {
    const writer = new CastWriter(path, { width: 80, height: 24 });
    writer.output(0, "\u001b[32mhello\u001b[0m");
    writer.output(1_234, "line two\r\n");
    writer.resize(2_500, 80, 24);
    writer.output(3_000, 'quotes " and backslash \\ and tab\t');
    await writer.close();

    const { events } = parseCast(readFileSync(path, "utf8"));
    expect(events).toHaveLength(4);

    expect(castEventAt(events, 0).code).toBe("o");
    expect(castEventAt(events, 0).t).toBeCloseTo(0, 6);
    expect(castEventAt(events, 0).data).toBe("\u001b[32mhello\u001b[0m");

    expect(castEventAt(events, 1).t).toBeCloseTo(1.234, 6);
    expect(castEventAt(events, 1).data).toBe("line two\r\n");

    expect(castEventAt(events, 2).code).toBe("r");
    expect(castEventAt(events, 2).t).toBeCloseTo(2.5, 6);
    expect(castEventAt(events, 2).data).toBe("80x24");

    expect(castEventAt(events, 3).data).toBe('quotes " and backslash \\ and tab\t');
  });

  it("writes event times as seconds with six decimal places", async () => {
    const writer = new CastWriter(path, { width: 80, height: 24 });
    writer.output(7, "a");
    writer.output(41_600, "b");
    await writer.close();

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines[1]).toMatch(/^\[0\.007000, "o", /);
    expect(lines[2]).toMatch(/^\[41\.600000, "o", /);
  });

  it("ignores writes issued after close", async () => {
    const writer = new CastWriter(path, { width: 80, height: 24 });
    writer.output(0, "before");
    await writer.close();
    writer.output(10, "after");
    writer.resize(10, 100, 40);
    await writer.close();

    expect(parseCast(readFileSync(path, "utf8")).events).toHaveLength(1);
  });
});

describe("parseCast", () => {
  it("rejects an empty file", () => {
    expect(() => parseCast("")).toThrow(/empty cast file/);
    expect(() => parseCast("\n  \n")).toThrow(/empty cast file/);
  });

  it("rejects a header that is not asciicast v2", () => {
    expect(() => parseCast('{"version":1,"width":80,"height":24}\n')).toThrow(
      /unsupported cast version: 1/,
    );
  });

  it("skips malformed event lines and keeps the valid ones", () => {
    const text = [
      '{"version":2,"width":80,"height":24}',
      '[0.000000, "o", "first"]',
      '[1.000000, "o", "tor',
      "not json at all",
      '["1.5", "o", "time is a string"]',
      '[2.000000, "o", 42]',
      '[3.000000, "o", "last"]',
      "",
    ].join("\n");

    const { events } = parseCast(text);
    expect(events.map((event) => event.data)).toEqual(["first", "last"]);
  });
});
