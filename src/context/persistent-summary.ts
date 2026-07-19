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
import type { CompactionCheckpoint } from "./compaction-checkpoint.js";
import { redactSecrets as redactPersistedSecrets } from "../adaptive/redact.js";

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
  epoch?: number;
  checkpoint?: CompactionCheckpoint;
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
  epoch?: number;
  checkpoint?: CompactionCheckpoint;
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

// Cap the index file size so long-running workspaces don't accumulate
// thousands of summary rows. When the index exceeds the cap, the
// oldest rows are moved into <summaryDir>/archive/index.jsonl and the
// associated .md bodies are deleted. The archiver keeps the most
// recent N entries searchable by default.
const INDEX_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const INDEX_KEEP_ROWS = 500;
const ARCHIVE_INDEX_NAME = "archive-index.jsonl";

async function rotateSummaryIndexIfNeeded(workspaceRoot: string): Promise<void> {
  const idx = indexPath(workspaceRoot);
  let stat: Awaited<ReturnType<typeof statAsync>>;
  try {
    stat = await statAsync(idx);
  } catch {
    return;
  }
  if (stat.size <= INDEX_MAX_BYTES) return;
  const { readFile, writeFile, mkdir, unlink } = await import("node:fs/promises");
  const raw = await readFile(idx, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= INDEX_KEEP_ROWS) return;
  const dropCount = lines.length - INDEX_KEEP_ROWS;
  const dropped = lines.slice(0, dropCount);
  const kept = lines.slice(dropCount);
  const archivePath = path.join(summaryDir(workspaceRoot), ARCHIVE_INDEX_NAME);
  await mkdir(summaryDir(workspaceRoot), { recursive: true });
  // Append dropped rows to the archive, then drop their .md bodies.
  let existingArchive = "";
  try {
    existingArchive = await readFile(archivePath, "utf8");
  } catch {
    // no archive yet
  }
  await writeFile(archivePath, `${existingArchive}${dropped.join("\n")}\n`, "utf8");
  await writeFile(idx, `${kept.join("\n")}\n`, "utf8");
  for (const line of dropped) {
    try {
      const row = JSON.parse(line) as { file?: string };
      if (row.file && row.file.startsWith(summaryDir(workspaceRoot))) {
        await unlink(row.file).catch(() => undefined);
      }
    } catch {
      // skip malformed row
    }
  }
}

async function statAsync(path: string): Promise<{ size: number }> {
  const { stat } = await import("node:fs/promises");
  return stat(path);
}

function redactTextForPersistence(value: string): string {
  return redactPersistedSecrets(value).redacted;
}

function redactCheckpointForPersistence(checkpoint: CompactionCheckpoint): CompactionCheckpoint {
  return JSON.parse(
    JSON.stringify(checkpoint, (_key, value: unknown) =>
      typeof value === "string" ? redactTextForPersistence(value) : value,
    ),
  ) as CompactionCheckpoint;
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
    ...(input.query !== undefined ? { query: redactTextForPersistence(input.query) } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    ...(input.checkpoint !== undefined
      ? { checkpoint: redactCheckpointForPersistence(input.checkpoint) }
      : {}),
    body: redactTextForPersistence(input.body),
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
    ...(input.epoch !== undefined ? [`epoch: ${input.epoch}`] : []),
    ...(summary.query ? `query: ${JSON.stringify(summary.query)}` : []),
    "---",
  ].join("\n");
  await writeFile(filePath, `${frontmatter}\n\n${summary.body}\n`, "utf8");
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
    ...(summary.query !== undefined ? { query: summary.query } : {}),
    ...(summary.epoch !== undefined ? { epoch: summary.epoch } : {}),
    ...(summary.checkpoint !== undefined ? { checkpoint: summary.checkpoint } : {}),
    bodyPreview: summary.body.slice(0, 500),
  };
  await appendFile(indexPath(workspaceRoot), `${JSON.stringify(indexRow)}\n`, "utf8");
  await rotateSummaryIndexIfNeeded(workspaceRoot);
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
        epoch?: number;
        checkpoint?: CompactionCheckpoint;
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
        ...(r.epoch !== undefined ? { epoch: r.epoch } : {}),
        ...(r.checkpoint !== undefined ? { checkpoint: r.checkpoint } : {}),
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
