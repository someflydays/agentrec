import {
  MATCH_CLOSE,
  MATCH_OPEN,
  rebuildIndex,
  type SearchResult,
  type SessionEventType,
  SessionStore,
  search,
  syncIndex,
} from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { formatRelativeTime, truncate } from "../format.js";

const DEFAULT_LIMIT = 20;
const MAX_TITLE_CHARS = 48;
const MAX_SNIPPET_CHARS = 160;
/** Indexing this many sessions is slow enough that the user deserves to know it happened. */
const QUIET_SYNC_LIMIT = 2;

const MATCH_PATTERN = new RegExp(`${MATCH_OPEN}([^${MATCH_CLOSE}]*)${MATCH_CLOSE}`, "g");

interface SearchCliOptions {
  limit: string;
  session?: string;
  type?: string[];
  json?: boolean;
  rebuild?: boolean;
}

interface SessionGroup {
  id: string;
  title?: string;
  startedAt: string;
  hits: SearchResult[];
}

function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`invalid --limit value "${value}"`);
  }
  return limit;
}

function collectType(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderSnippet(snippet: string): string {
  return (
    truncate(snippet, MAX_SNIPPET_CHARS)
      .replace(MATCH_PATTERN, (_match, term: string) => pc.bold(term))
      // Truncation can orphan an opening delimiter with no closer left to pair it.
      .replaceAll(MATCH_OPEN, "")
      .replaceAll(MATCH_CLOSE, "")
  );
}

function groupBySession(results: SearchResult[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const result of results) {
    let group = groups.get(result.sessionId);
    if (group === undefined) {
      group = {
        id: result.sessionId,
        ...(result.sessionTitle !== undefined ? { title: result.sessionTitle } : {}),
        startedAt: result.sessionStartedAt,
        hits: [],
      };
      groups.set(result.sessionId, group);
    }
    group.hits.push(result);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  for (const group of ordered) group.hits.sort((a, b) => a.seq - b.seq);
  return ordered;
}

function printGroups(groups: SessionGroup[]): void {
  const typeWidth = Math.max(
    ...groups.flatMap((group) => group.hits.map((hit) => hit.type.length)),
  );
  for (const group of groups) {
    const title = group.title === undefined ? "" : `  ${truncate(group.title, MAX_TITLE_CHARS)}`;
    const age = pc.dim(`  ${formatRelativeTime(group.startedAt)}`);
    console.log(`${pc.bold(group.id.slice(0, 8).toLowerCase())}${title}${age}`);
    for (const hit of group.hits) {
      const offset = pc.dim(formatOffset(hit.t));
      const type = pc.dim(hit.type.padEnd(typeWidth));
      console.log(`  ${offset}  ${type}  ${renderSnippet(hit.snippet)}`);
    }
    console.log("");
  }
}

function countOf(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Full-text search across recorded sessions")
    .argument("<query...>", "words to search for")
    .option("--limit <n>", "maximum number of matches", String(DEFAULT_LIMIT))
    .option("--session <id>", "restrict to one session id or unique id prefix")
    .option("--type <type>", "restrict to an event type (repeatable)", collectType, [])
    .option("--json", "print the raw results as JSON")
    .option("--rebuild", "discard the index and reindex every session first")
    .action((words: string[], options: SearchCliOptions) => {
      const store = new SessionStore();
      const query = words.join(" ");
      const json = options.json === true;

      const stats = options.rebuild === true ? rebuildIndex(store) : syncIndex(store);
      if (!json && stats.indexed > QUIET_SYNC_LIMIT) {
        console.log(pc.dim(`indexed ${countOf(stats.indexed, "session")}`));
      }

      const results = search(store, query, {
        limit: parseLimit(options.limit),
        ...(options.session !== undefined ? { sessionId: store.resolveId(options.session) } : {}),
        // An event type the recorder never emits simply matches nothing.
        ...((options.type ?? []).length > 0 ? { types: options.type as SessionEventType[] } : {}),
      });

      if (json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (results.length === 0) {
        if (stats.indexed + stats.skipped === 0) {
          console.log(`No sessions recorded yet. Start one with ${pc.bold("agentrec claude")}.`);
        } else {
          console.log(`No matches for ${pc.bold(query)}.`);
        }
        return;
      }

      const groups = groupBySession(results);
      printGroups(groups);
      console.log(
        pc.dim(
          `${countOf(results.length, "match", "matches")} in ${countOf(groups.length, "session")}`,
        ),
      );
    });
}
