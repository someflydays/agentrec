import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CAST_FILE, EVENTS_FILE, META_FILE, type SessionStore } from "./session-store.js";
import type { SessionEvent, SessionMeta } from "./types.js";

/**
 * A .agentlog file is a complete, portable session: gzipped JSON containing
 * the meta, the event log, and the terminal cast. One file to attach to an
 * issue, publish, or open on another machine.
 */
export const AGENTLOG_VERSION = 1;
export const AGENTLOG_EXTENSION = ".agentlog";

export interface AgentlogBundle {
  format: "agentlog";
  version: typeof AGENTLOG_VERSION;
  meta: SessionMeta;
  events: SessionEvent[];
  cast: string | null;
}

export function packBundle(bundle: Omit<AgentlogBundle, "format" | "version">): Buffer {
  const full: AgentlogBundle = { format: "agentlog", version: AGENTLOG_VERSION, ...bundle };
  return gzipSync(Buffer.from(JSON.stringify(full), "utf8"));
}

export function unpackBundle(data: Buffer | Uint8Array): AgentlogBundle {
  let json: string;
  try {
    json = gunzipSync(data).toString("utf8");
  } catch {
    throw new Error("not a valid .agentlog file (gunzip failed)");
  }
  const bundle = JSON.parse(json) as AgentlogBundle;
  if (bundle.format !== "agentlog") {
    throw new Error("not a valid .agentlog file (unexpected format field)");
  }
  if (bundle.version !== AGENTLOG_VERSION) {
    throw new Error(`unsupported .agentlog version ${String(bundle.version)}`);
  }
  return bundle;
}

export function exportSession(store: SessionStore, id: string, outPath: string): void {
  const meta = store.readMeta(id);
  const events = store.readEvents(id);
  const cast = store.readCast(id);
  writeFileSync(outPath, packBundle({ meta, events, cast }));
}

export interface ImportOptions {
  /** Replace an existing session with the same id. Default: false (throws). */
  overwrite?: boolean;
}

/** Import a bundle into the store under its original session id. */
export function importBundle(
  store: SessionStore,
  bundle: AgentlogBundle,
  options: ImportOptions = {},
): string {
  const id = bundle.meta.id;
  if (store.has(id)) {
    if (!options.overwrite) {
      throw new Error(`session ${id} already exists (pass overwrite to replace it)`);
    }
    store.delete(id);
  }
  store.ensure();
  const dir = store.sessionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, META_FILE), `${JSON.stringify(bundle.meta, null, 2)}\n`);
  const lines = bundle.events.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(join(dir, EVENTS_FILE), lines.length > 0 ? `${lines}\n` : "");
  if (bundle.cast !== null) {
    writeFileSync(join(dir, CAST_FILE), bundle.cast);
  }
  return id;
}

export function importFile(store: SessionStore, path: string, options: ImportOptions = {}): string {
  return importBundle(store, unpackBundle(readFileSync(path)), options);
}
