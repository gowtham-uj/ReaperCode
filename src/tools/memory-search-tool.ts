/**
 * tools/memory-search-tool.ts — search Reaper's persistent memory.
 *
 * The model can call this tool to recall prior session summaries
 * (full-summarization results persisted to .reaper/summaries/index.jsonl).
 * Used during long-running autonomous sessions when the conversation
 * has been compacted and the model needs to remember what it was
 * doing hours or days ago.
 */

import { z } from "zod";

import { searchMemory, loadFullSummary } from "../context/memory-search.js";
import { SearchMemoryArgsSchema } from "./types.js";

export type SearchMemoryArgs = z.infer<typeof SearchMemoryArgsSchema>;

export interface SearchMemoryToolOptions {
  workspaceRoot: string;
}

export async function executeSearchMemory(
  args: SearchMemoryArgs,
  options: SearchMemoryToolOptions,
): Promise<{ hits: Array<Record<string, unknown>>; total_summaries: number }> {
  const hits = await searchMemory(options.workspaceRoot, args.query, {
    ...(args.max_hits !== undefined ? { maxHits: args.max_hits } : {}),
    ...(args.include_body !== undefined ? { includeBody: args.include_body } : {}),
    ...(args.session_id ? { sessionId: args.session_id } : {}),
    ...(args.since ? { since: args.since } : {}),
  });
  const out: Array<Record<string, unknown>> = [];
  for (const h of hits) {
    const hit: Record<string, unknown> = {
      id: h.id,
      createdAt: h.createdAt,
      query: h.query,
      score: h.score,
      bodyPreview: h.bodyPreview,
    };
    if (args.include_body) {
      const full = await loadFullSummary(options.workspaceRoot, h.id);
      if (full) {
        hit.body = full.body;
        hit.preChars = full.preChars;
        hit.postChars = full.postChars;
        hit.savedChars = full.savedChars;
      }
    }
    out.push(hit);
  }
  // Also count total available for context.
  const all = (await import("../context/persistent-summary.js")).loadAllSummaries(options.workspaceRoot);
  return { hits: out, total_summaries: all.length };
}
