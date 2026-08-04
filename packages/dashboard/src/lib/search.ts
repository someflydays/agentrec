import {
  MATCH_CLOSE,
  MATCH_OPEN,
  type SearchResult,
  stripDelimiters,
} from "@agentrec/core/browser";

export type { SearchResult };

export interface SnippetRun {
  text: string;
  match: boolean;
}

/**
 * Splits an FTS5 snippet into plain and matched runs. Server-side truncation can
 * orphan a delimiter, so unpaired ones are dropped rather than rendered.
 */
export function splitSnippet(snippet: string): SnippetRun[] {
  const runs: SnippetRun[] = [];
  let index = 0;
  while (index < snippet.length) {
    const open = snippet.indexOf(MATCH_OPEN, index);
    if (open === -1) break;
    const close = snippet.indexOf(MATCH_CLOSE, open + 1);
    if (close === -1) break;
    if (open > index) runs.push({ text: snippet.slice(index, open), match: false });
    runs.push({ text: snippet.slice(open + 1, close), match: true });
    index = close + 1;
  }
  if (index < snippet.length) runs.push({ text: snippet.slice(index), match: false });

  return runs
    .map((run) => (run.match ? run : { text: stripDelimiters(run.text), match: false }))
    .filter((run) => run.text.length > 0);
}

export interface SearchGroup {
  id: string;
  title?: string;
  startedAt: string;
  hits: SearchResult[];
}

/** Newest session first, then in playback order within a session. */
export function groupBySession(results: SearchResult[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
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
