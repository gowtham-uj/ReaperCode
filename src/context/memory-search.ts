/**
 * context/memory-search.ts — search past summaries.
 *
 * For days-long autonomous operation, the model needs to be able to
 * recall what it was doing hours or days ago. The memory-search tool
 * queries `.reaper/summaries/index.jsonl` and returns the most relevant
 * summaries for a given query string.
 *
 * The search is intentionally simple: keyword overlap scoring. We don't
 * pull in an embedding model here because the goal is a fast, local,
 * dependency-free retrieval over the summary index. The model can use
 * `read_file` to load the full body of any summary it picks.
 */

import { loadAllSummaries, loadSummaryBody, type PersistentSummary } from "./persistent-summary.js";

export interface MemorySearchHit {
  id: string;
  createdAt: string;
  file: string;
  query?: string;
  bodyPreview: string;
  /** Number of keyword overlaps. Higher = more relevant. */
  score: number;
  /** Optional fields when the full body is loaded. */
  body?: string;
  preChars?: number;
  postChars?: number;
  savedChars?: number;
}

export interface MemorySearchOptions {
  /** Max hits to return. Default 5. */
  maxHits?: number;
  /** Include the full body in the hits. Default false (preview only). */
  includeBody?: boolean;
  /** Filter by session_id. */
  sessionId?: string;
  /** Filter by minimum createdAt (inclusive). */
  since?: string;
}

const DEFAULT_MAX_HITS = 5;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

export async function searchMemory(
  workspaceRoot: string,
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchHit[]> {
  const maxHits = options.maxHits ?? DEFAULT_MAX_HITS;
  const summaries = loadAllSummaries(workspaceRoot).filter((s) => {
    if (options.sessionId && s.sessionId !== options.sessionId) return false;
    if (options.since && s.createdAt < options.since) return false;
    return true;
  });
  if (summaries.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    // No query tokens: return the most recent N.
    const recent = summaries.slice(-maxHits);
    return recent.map((s) => summaryToHit(s, 0, options.includeBody ?? false, workspaceRoot));
  }
  const hits: MemorySearchHit[] = [];
  for (const s of summaries) {
    const haystackTokens = tokenize(`${s.body} ${s.query ?? ""}`);
    let score = 0;
    for (const t of queryTokens) if (haystackTokens.has(t)) score += 1;
    if (score > 0) hits.push(summaryToHit(s, score, options.includeBody ?? false, workspaceRoot));
  }
  hits.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  return hits.slice(0, maxHits);
}

function summaryToHit(
  s: PersistentSummary,
  score: number,
  includeBody: boolean,
  workspaceRoot: string,
): MemorySearchHit {
  const hit: MemorySearchHit = {
    id: s.id,
    createdAt: s.createdAt,
    file: `${workspaceRoot}/.reaper/summaries/...`, // placeholder; real path is in index
    bodyPreview: s.body,
    score,
  };
  if (s.query) hit.query = s.query;
  if (includeBody) {
    // Lazy: caller can use loadSummaryBody if they need the full thing.
    hit.body = s.body;
  }
  return hit;
}

export async function loadFullSummary(workspaceRoot: string, id: string): Promise<PersistentSummary | null> {
  const body = await loadSummaryBody(workspaceRoot, id);
  if (body === null) return null;
  const all = loadAllSummaries(workspaceRoot);
  const found = all.find((s) => s.id === id);
  if (!found) return null;
  return { ...found, body };
}
