import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionEventData,
  type SessionEventType,
  type SessionMeta,
} from "./types.js";

export const META_FILE = "meta.json";
export const EVENTS_FILE = "events.jsonl";
export const CAST_FILE = "terminal.cast";

export function defaultStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_BLACKBOX_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".agent-blackbox");
}

function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/**
 * Filesystem layout: <root>/sessions/<id>/{meta.json, events.jsonl, terminal.cast}.
 * Events are append-only JSONL; meta.json is rewritten atomically on update.
 */
export class SessionStore {
  readonly root: string;
  readonly sessionsDir: string;

  constructor(root: string = defaultStoreRoot()) {
    this.root = root;
    this.sessionsDir = join(root, "sessions");
  }

  ensure(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  newSessionId(): string {
    return ulid();
  }

  sessionDir(id: string): string {
    return join(this.sessionsDir, id);
  }

  has(id: string): boolean {
    return existsSync(join(this.sessionDir(id), META_FILE));
  }

  createSession(meta: Omit<SessionMeta, "formatVersion">): SessionWriter {
    const full: SessionMeta = { formatVersion: SESSION_FORMAT_VERSION, ...meta };
    const dir = this.sessionDir(full.id);
    if (existsSync(dir)) {
      throw new Error(`session ${full.id} already exists at ${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    const writer = new SessionWriter(dir, full);
    writer.event("session.start", { meta: full });
    return writer;
  }

  readMeta(id: string): SessionMeta {
    const raw = readFileSync(join(this.sessionDir(id), META_FILE), "utf8");
    return JSON.parse(raw) as SessionMeta;
  }

  /**
   * Tolerant read: skips lines that fail to parse (e.g. a torn final line
   * after a crash) rather than failing the whole session.
   */
  readEvents(id: string): SessionEvent[] {
    const path = join(this.sessionDir(id), EVENTS_FILE);
    if (!existsSync(path)) return [];
    const events: SessionEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // torn write — skip
      }
    }
    return events;
  }

  castPath(id: string): string {
    return join(this.sessionDir(id), CAST_FILE);
  }

  readCast(id: string): string | null {
    const path = this.castPath(id);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  list(): SessionMeta[] {
    if (!existsSync(this.sessionsDir)) return [];
    const metas: SessionMeta[] = [];
    for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        metas.push(this.readMeta(entry.name));
      } catch {
        // incomplete session dir — skip
      }
    }
    metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return metas;
  }

  /** Resolve an exact id or an unambiguous case-insensitive prefix. */
  resolveId(idOrPrefix: string): string {
    if (this.has(idOrPrefix)) return idOrPrefix;
    const needle = idOrPrefix.toLowerCase();
    const matches = this.list()
      .map((m) => m.id)
      .filter((id) => id.toLowerCase().startsWith(needle));
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    if (matches.length === 0) throw new Error(`no session matching "${idOrPrefix}"`);
    throw new Error(`ambiguous session prefix "${idOrPrefix}" (${matches.length} matches)`);
  }

  delete(id: string): void {
    rmSync(this.sessionDir(id), { recursive: true, force: true });
  }
}

export class SessionWriter {
  readonly dir: string;
  private meta: SessionMeta;
  private seq = 0;
  private readonly startMs: number;
  private readonly eventsPath: string;

  constructor(dir: string, meta: SessionMeta) {
    this.dir = dir;
    this.meta = meta;
    this.startMs = Date.parse(meta.startedAt);
    this.eventsPath = join(dir, EVENTS_FILE);
    this.flushMeta();
  }

  get sessionMeta(): SessionMeta {
    return this.meta;
  }

  get castPath(): string {
    return join(this.dir, CAST_FILE);
  }

  elapsedMs(now: number = Date.now()): number {
    return Math.max(0, now - this.startMs);
  }

  event<T extends SessionEventType>(type: T, data: SessionEventData<T>, atMs?: number): void {
    const record: SessionEvent = {
      seq: this.seq++,
      t: atMs ?? this.elapsedMs(),
      type,
      data,
    } as SessionEvent;
    appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`);
  }

  updateMeta(patch: Partial<Omit<SessionMeta, "formatVersion" | "id">>): void {
    this.meta = { ...this.meta, ...patch };
    this.flushMeta();
  }

  end(exitCode: number | null): void {
    this.event("session.end", { exitCode });
    this.updateMeta({ endedAt: new Date().toISOString(), exitCode });
  }

  private flushMeta(): void {
    writeFileAtomic(join(this.dir, META_FILE), `${JSON.stringify(this.meta, null, 2)}\n`);
  }
}
