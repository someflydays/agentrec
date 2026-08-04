import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { EVENTS_FILE, type SessionStore } from "./session-store.js";
import type { SessionEvent, SessionEventType } from "./types.js";

/**
 * An FTS5 index over recorded sessions, kept at <store root>/index.db. The
 * JSONL files remain the source of truth, so the index is a disposable cache:
 * a corrupt, locked, or version-mismatched file is deleted and rebuilt rather
 * than reported as a failure.
 */
export const SEARCH_SCHEMA_VERSION = 1;
export const INDEX_FILE = "index.db";

/** Delimiters around matched terms in a snippet; control codes never collide with indexed text. */
export const MATCH_OPEN = "\u0002";
export const MATCH_CLOSE = "\u0003";

const SNIPPET_ELLIPSIS = "…";
const SNIPPET_TOKENS = 16;
const DEFAULT_LIMIT = 20;
/** A single tool output can be megabytes; only the head of an event's text is indexed. */
const MAX_TEXT_CHARS = 20_000;
const MAX_FLATTEN_DEPTH = 6;
/** Caps on a parsed query, so pathological input cannot build a huge expression tree. */
const MAX_QUERY_TERMS = 32;
const MAX_TERM_CHARS = 256;

const MALFORMED_QUERY = /fts5: syntax error|no such column/;

export interface SearchOptions {
  /** Maximum hits to return. Default 20. */
  limit?: number;
  /** Restrict to one session id (exact, not a prefix). */
  sessionId?: string;
  /** Restrict to these event types. */
  types?: SessionEventType[];
  /** Pass the query to FTS5 verbatim instead of quoting it; malformed syntax throws. */
  raw?: boolean;
}

export interface SearchResult {
  sessionId: string;
  sessionTitle?: string;
  sessionStartedAt: string;
  seq: number;
  type: SessionEventType;
  /** Milliseconds since the session started, mirroring SessionEvent.t. */
  t: number;
  /** Matched terms wrapped in MATCH_OPEN/MATCH_CLOSE. */
  snippet: string;
  /** FTS5 bm25 score; more negative is a better match. */
  score: number;
}

export interface SyncStats {
  /** Sessions read from disk and written into the index. */
  indexed: number;
  /** Sessions left untouched because events.jsonl was unchanged. */
  skipped: number;
  /** Sessions dropped from the index because they no longer exist on disk. */
  removed: number;
}

/** A malformed FTS5 expression, only reachable through `raw` — not an index problem. */
export class SearchQueryError extends Error {}

export function indexPath(store: SessionStore): string {
  return join(store.root, INDEX_FILE);
}

// node:sqlite prints an ExperimentalWarning as it loads on Node 22 and 23, so it
// is resolved on first use: commands that never search must not pay for it.
let sqlite: typeof import("node:sqlite") | undefined;

function openDatabase(path: string): DatabaseSync {
  sqlite ??= process.getBuiltinModule("node:sqlite");
  return new sqlite.DatabaseSync(path);
}

type Row = Record<string, SQLOutputValue>;

function textOf(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function numberOf(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_FLATTEN_DEPTH) return;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out, depth + 1);
    }
  }
}

/** Tool inputs are arbitrary JSON; only their string leaves (commands, paths, patterns) are text. */
function flattenToolInput(input: unknown): string {
  const parts: string[] = [];
  collectStrings(input, parts, 0);
  return parts.join(" ");
}

function searchableText(event: SessionEvent): string {
  switch (event.type) {
    case "prompt":
      return event.data.text;
    case "assistant.text":
      return event.data.text;
    case "notification":
      return event.data.message;
    case "session.title":
      return event.data.title;
    case "tool.start":
      return flattenToolInput(event.data.input);
    case "tool.end":
      return event.data.output ?? "";
    case "file.change":
      return event.data.path;
    default:
      return "";
  }
}

/** Snippets are rendered on one line, so runs of whitespace collapse before indexing. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/**
 * FTS5 MATCH is a query language: bare user input like `foo:bar` or `"unclosed`
 * is a syntax error. Every whitespace-separated term becomes a quoted phrase, so
 * arbitrary input reduces to an AND of literal terms and can never throw.
 */
export function toMatchExpression(query: string): string {
  return query
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_QUERY_TERMS)
    .map((term) => `"${term.slice(0, MAX_TERM_CHARS).replaceAll('"', '""')}"`)
    .join(" ");
}

/** Returns true when the tables were (re)created, so the caller knows the index is empty. */
function applySchema(db: DatabaseSync): boolean {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  if (stored !== undefined && textOf(stored, "value") === String(SEARCH_SCHEMA_VERSION)) {
    return false;
  }

  db.exec("DROP TABLE IF EXISTS events");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    startedAt TEXT NOT NULL,
    endedAt TEXT,
    mtimeMs REAL NOT NULL,
    size INTEGER NOT NULL,
    indexedAt TEXT NOT NULL
  )`);
  db.exec(`CREATE VIRTUAL TABLE events USING fts5(
    text,
    sessionId UNINDEXED,
    seq UNINDEXED,
    type UNINDEXED,
    t UNINDEXED,
    tokenize='unicode61'
  )`);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)").run(
    String(SEARCH_SCHEMA_VERSION),
  );
  return true;
}

function discardIndex(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function runWithDatabase<T>(
  store: SessionStore,
  run: (db: DatabaseSync, fresh: boolean) => T,
  forceFresh: boolean,
): T {
  mkdirSync(store.root, { recursive: true });
  const db = openDatabase(indexPath(store));
  try {
    const recreated = applySchema(db);
    return run(db, recreated || forceFresh);
  } finally {
    db.close();
  }
}

/**
 * Run against the index, discarding and recreating it once if anything fails.
 * `fresh` tells the caller it is looking at an empty index and must repopulate.
 */
function withIndex<T>(store: SessionStore, run: (db: DatabaseSync, fresh: boolean) => T): T {
  try {
    return runWithDatabase(store, run, false);
  } catch (error) {
    if (error instanceof SearchQueryError) throw error;
    const path = indexPath(store);
    discardIndex(path);
    try {
      return runWithDatabase(store, run, true);
    } catch (retryError) {
      const cause = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`search index at ${path} is unusable: ${cause}`);
    }
  }
}

function inTransaction(db: DatabaseSync, body: () => void): void {
  db.exec("BEGIN");
  try {
    body();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface IndexedSession {
  endedAt: string | null;
  mtimeMs: number;
  size: number;
}

function eventsStat(store: SessionStore, id: string): { mtimeMs: number; size: number } {
  try {
    const stats = statSync(join(store.sessionDir(id), EVENTS_FILE));
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function syncInto(db: DatabaseSync, store: SessionStore): SyncStats {
  const known = new Map<string, IndexedSession>();
  for (const row of db.prepare("SELECT id, endedAt, mtimeMs, size FROM sessions").all()) {
    const endedAt = row.endedAt;
    known.set(textOf(row, "id"), {
      endedAt: typeof endedAt === "string" ? endedAt : null,
      mtimeMs: numberOf(row, "mtimeMs"),
      size: numberOf(row, "size"),
    });
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (text, sessionId, seq, type, t) VALUES (?, ?, ?, ?, ?)",
  );
  const deleteEvents = db.prepare("DELETE FROM events WHERE sessionId = ?");
  const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
  const upsertSession = db.prepare(`INSERT INTO sessions
      (id, title, startedAt, endedAt, mtimeMs, size, indexedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      startedAt = excluded.startedAt,
      endedAt = excluded.endedAt,
      mtimeMs = excluded.mtimeMs,
      size = excluded.size,
      indexedAt = excluded.indexedAt`);

  const stats: SyncStats = { indexed: 0, skipped: 0, removed: 0 };
  const present = new Set<string>();

  for (const meta of store.list()) {
    present.add(meta.id);
    const stat = eventsStat(store, meta.id);
    const prior = known.get(meta.id);
    // A live session keeps growing, so it is re-read every sync; an ended one is
    // skipped entirely when events.jsonl matches byte-for-byte what was indexed.
    const unchanged =
      prior !== undefined &&
      prior.endedAt !== null &&
      meta.endedAt !== undefined &&
      prior.mtimeMs === stat.mtimeMs &&
      prior.size === stat.size;
    if (unchanged) {
      stats.skipped += 1;
      continue;
    }

    inTransaction(db, () => {
      deleteEvents.run(meta.id);
      let title = meta.title ?? null;
      for (const event of store.readEvents(meta.id)) {
        if (event.type === "session.title") title = event.data.title;
        const text = normalizeText(searchableText(event));
        if (text.length === 0) continue;
        insertEvent.run(text, meta.id, event.seq, event.type, event.t);
      }
      upsertSession.run(
        meta.id,
        title,
        meta.startedAt,
        meta.endedAt ?? null,
        stat.mtimeMs,
        stat.size,
        new Date().toISOString(),
      );
    });
    stats.indexed += 1;
  }

  for (const id of known.keys()) {
    if (present.has(id)) continue;
    inTransaction(db, () => {
      deleteEvents.run(id);
      deleteSession.run(id);
    });
    stats.removed += 1;
  }

  return stats;
}

function runQuery(db: DatabaseSync, expression: string, options: SearchOptions): SearchResult[] {
  const where = ["events MATCH ?"];
  const params: SQLInputValue[] = [
    MATCH_OPEN,
    MATCH_CLOSE,
    SNIPPET_ELLIPSIS,
    SNIPPET_TOKENS,
    expression,
  ];
  if (options.sessionId !== undefined) {
    where.push("events.sessionId = ?");
    params.push(options.sessionId);
  }
  const types = options.types ?? [];
  if (types.length > 0) {
    where.push(`events.type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  params.push(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));

  const sql = `SELECT events.sessionId AS sessionId,
      events.seq AS seq,
      events.type AS type,
      events.t AS t,
      snippet(events, 0, ?, ?, ?, ?) AS snippet,
      bm25(events) AS score,
      sessions.title AS title,
      sessions.startedAt AS startedAt
    FROM events
    JOIN sessions ON sessions.id = events.sessionId
    WHERE ${where.join(" AND ")}
    ORDER BY bm25(events), sessions.startedAt DESC, events.seq
    LIMIT ?`;

  let rows: Row[];
  try {
    rows = db.prepare(sql).all(...params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.raw === true && MALFORMED_QUERY.test(message)) {
      throw new SearchQueryError(`invalid search query: ${message}`);
    }
    throw error;
  }

  return rows.map((row) => {
    const title = row.title;
    return {
      sessionId: textOf(row, "sessionId"),
      ...(typeof title === "string" ? { sessionTitle: title } : {}),
      sessionStartedAt: textOf(row, "startedAt"),
      seq: numberOf(row, "seq"),
      type: textOf(row, "type") as SessionEventType,
      t: numberOf(row, "t"),
      snippet: textOf(row, "snippet"),
      score: numberOf(row, "score"),
    };
  });
}

/** Bring the index up to date with the store, reindexing only what changed. */
export function syncIndex(store: SessionStore): SyncStats {
  return withIndex(store, (db) => syncInto(db, store));
}

/** Throw the index away and index every session from scratch. */
export function rebuildIndex(store: SessionStore): SyncStats {
  discardIndex(indexPath(store));
  return withIndex(store, (db) => syncInto(db, store));
}

/**
 * Search indexed sessions. Call `syncIndex` first for up-to-date results; this
 * only reindexes when it has to recover a broken index.
 */
export function search(
  store: SessionStore,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const expression = options.raw === true ? query.trim() : toMatchExpression(query);
  if (expression.length === 0) return [];
  return withIndex(store, (db, fresh) => {
    if (fresh) syncInto(db, store);
    return runQuery(db, expression, options);
  });
}
