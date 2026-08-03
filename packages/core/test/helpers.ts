import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionEventData, SessionEventType } from "../src/types.js";

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "abb-"));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function makeEvent<T extends SessionEventType>(
  seq: number,
  t: number,
  type: T,
  data: SessionEventData<T>,
): SessionEvent {
  return { seq, t, type, data } as SessionEvent;
}

export function eventAt(events: SessionEvent[], index: number): SessionEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`no event at index ${index} (length ${events.length})`);
  }
  return event;
}

/** Index into an event list and narrow to a single event variant. */
export function expectEvent<T extends SessionEventType>(
  events: SessionEvent[],
  index: number,
  type: T,
): Extract<SessionEvent, { type: T }> {
  const event = eventAt(events, index);
  if (event.type !== type) {
    throw new Error(`expected ${type} at index ${index}, found ${event.type}`);
  }
  return event as Extract<SessionEvent, { type: T }>;
}

export function firstOfType<T extends SessionEventType>(
  events: SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }> {
  const found = events.find((event) => event.type === type);
  if (found === undefined) {
    throw new Error(`no event of type ${type}`);
  }
  return found as Extract<SessionEvent, { type: T }>;
}
