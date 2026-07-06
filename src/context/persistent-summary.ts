/**
 * context/persistent-summary.ts — durable summary storage.
 *
 * For days-long autonomous operation, full-summarization results must
 * outlive a single Reaper run. This module persists every summary to
 * `.reaper/summaries/<id>.md` (machine-readable frontmatter + human-
 * readable body) and maintains `.reaper/summaries/index.jsonl` so the
 * model can recall past summaries by date or query.
 *
 * The on-disk layout:
 *
 *   .reaper/summaries/
 *     index.jsonl                  # one JSON per line, all summaries in time order
 *     2026-07-05T12-00-00.md       # full summary, with frontmatter
 *     2026-07-05T14-30-00.md
 *     ...
 *
 * Each summary file has YAML-style frontmatter:
 *
 *   ---
 *   id: <uuid>
 *   created_at: <iso>
 *   session_id: <string>
 *   run_id: <string>
 *   pre_chars: <number>
 *   post_chars: <number>
 *   saved_chars: <number>
 *   ptl_drops: <number>
 *   reattached_files: <number>
 *   query: <string>  (optional user query that triggered this summary)
 *   ---
 *
 *   <body: the actual 9-section summary>
 *
 * The memory-search tool (see context/memory-search.ts) queries index.jsonl
 * to find past summaries.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export interface PersistentSummary {
  id: string;
  createdAt: string;
  sessionId: string;
  runId: string;
  preChars: number;
  postChars: number;
  savedChars: number;
  ptlDrops: number;
  reattachedFiles: number;
  query?: string;
  body: string;
}

export interface PersistSummaryInput {
  sessionId: string;
  runId: string;
  preChars: number;
  postChars: number;
  savedChars: number;
  ptlDrops: number;
  reattachedFiles: number;
  body: string;
  query?: string;
}

function summaryDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "summaries");
}

function indexPath(workspaceRoot: string): string {
  return path.join(summaryDir(workspaceRoot), "index.jsonl");
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function persistSummary(
  workspaceRoot: string,
  input: PersistSummaryInput,
): Promise<PersistentSummary> {
  const dir = summaryDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const summary: PersistentSummary = {
    id,
    createdAt,
    sessionId: input.sessionId,
    runId: input.runId,
    preChars: input.preChars,
    postChars: input.postChars,
    savedChars: input.savedChars,
    ptlDrops: input.ptlDrops,
    reattachedFiles: input.reattachedFiles,
    ...(input.query !== undefined ? { query: input.query } : {}),
    body: input.body,
  };
  // Write the .md file (frontmatter + body).
  const fileBase = safeTimestamp();
  const filePath = path.join(dir, `${fileBase}_${id.slice(0, 8)}.md`);
  const frontmatter = [
    "---",
    `id: ${id}`,
    `created_at: ${createdAt}`,
    `session_id: ${input.sessionId}`,
    `run_id: ${input.runId}`,
    `pre_chars: ${input.preChars}`,
    `post_chars: ${input.postChars}`,
    `saved_chars: ${input.savedChars}`,
    `ptl_drops: ${input.ptlDrops}`,
    `reattached_files: ${input.reattachedFiles}`,
    ...(input.query ? `query: ${JSON.stringify(input.query)}` : []),
    "---",
  ].join("\n");
  await writeFile(filePath, `${frontmatter}\n\n${input.body}\n`, "utf8");
  // Append a row to index.jsonl for cheap search.
  const indexRow = {
    id,
    createdAt,
    file: filePath,
    sessionId: input.sessionId,
    runId: input.runId,
    preChars: input.preChars,
    postChars: input.postChars,
    savedChars: input.savedChars,
    ptlDrops: input.ptlDrops,
    reattachedFiles: input.reattachedFiles,
    ...(input.query !== undefined ? { query: input.query } : {}),
    bodyPreview: input.body.slice(0, 500),
  };
  await appendFile(indexPath(workspaceRoot), `${JSON.stringify(indexRow)}\n`, "utf8");
  return summary;
}

export function loadAllSummaries(workspaceRoot: string): PersistentSummary[] {
  const idx = indexPath(workspaceRoot);
  if (!existsSync(idx)) return [];
  const rows: PersistentSummary[] = [];
  for (const line of readFileSync(idx, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        id: string;
        createdAt: string;
        file: string;
        sessionId: string;
        runId: string;
        preChars: number;
        postChars: number;
        savedChars: number;
        ptlDrops: number;
        reattachedFiles: number;
        query?: string;
        bodyPreview: string;
      };
      // Read the body lazily — for index lookup we just need the frontmatter.
      // Body is loaded from the .md file on demand.
      rows.push({
        id: r.id,
        createdAt: r.createdAt,
        sessionId: r.sessionId,
        runId: r.runId,
        preChars: r.preChars,
        postChars: r.postChars,
        savedChars: r.savedChars,
        ptlDrops: r.ptlDrops,
        reattachedFiles: r.reattachedFiles,
        ...(r.query !== undefined ? { query: r.query } : {}),
        body: r.bodyPreview, // not the full body, lazy-loaded below
      });
    } catch {
      // skip malformed rows
    }
  }
  return rows;
}

export async function loadSummaryBody(workspaceRoot: string, id: string): Promise<string | null> {
  const idx = indexPath(workspaceRoot);
  if (!existsSync(idx)) return null;
  for (const line of readFileSync(idx, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { id: string; file: string };
      if (r.id !== id) continue;
      const body = await readFile(r.file, "utf8");
      // Strip frontmatter and trim trailing newline.
      const m = body.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
      return m ? (m[1] ?? "").replace(/\n$/, "") : body;
    } catch {
      // skip
    }
  }
  return null;
}
