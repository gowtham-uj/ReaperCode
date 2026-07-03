import type { z } from "zod";
import { toolRegistry } from "../registry.js";
import { normalizeToolName } from "../../context/tool-search.js";
import { discoverTools } from "../discovery.js";
import { SearchToolsArgsSchema } from "../types.js";
import { bm25SearchTools, resetBM25Index } from "../bm25-search.js";
import { buildDescriptorsFromRegistry, resetDescriptors } from "../descriptor-builder.js";

export { SearchToolsArgsSchema };

export type SearchToolsArgs = z.infer<typeof SearchToolsArgsSchema>;

export interface SearchToolsResult {
  matches: Array<{ name: string; description: string }>;
  discovered: string[];
  total_tools: number;
}

/** Ensure descriptors are built before BM25 search. */
function ensureDescriptors(): void {
  if (getAllToolDescriptors().length === 0) {
    buildDescriptorsFromRegistry();
  }
}

// Need to import getAllToolDescriptors for the guard
import { getAllToolDescriptors } from "../descriptor.js";

/**
 * Search the tool registry by keyword (BM25) and promote matches to full-schema rendering.
 * The model calls this when it needs a capability not in the core tool set.
 *
 * Phase 2: now uses BM25 ranking over the ToolDescriptor index instead of
 * the old keyword-substring scoring. Select: prefix still works for exact
 * name promotion.
 */
export function executeSearchTools(query: string, runId: string): SearchToolsResult {
  ensureDescriptors();

  const normalized = query.toLowerCase().trim();
  const catalog = Object.entries(toolRegistry);
  const selectMatch = normalized.match(/^select:(.+)$/i);
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const selected = requested.flatMap((name) => {
      const direct = catalog.find(([toolName]) => toolName.toLowerCase() === name.toLowerCase());
      if (direct) return [{ name: direct[0], description: direct[1].description }];
      const normalizedName = normalizeToolName(name);
      const alias = catalog.find(([toolName]) => normalizeToolName(toolName) === normalizedName);
      return alias ? [{ name: alias[0], description: alias[1].description }] : [];
    });
    const discovered = [...new Set(selected.map((item) => item.name))];
    discoverTools(discovered, runId);
    return {
      matches: selected.filter((item, index) => selected.findIndex((other) => other.name === item.name) === index),
      discovered,
      total_tools: Object.keys(toolRegistry).length,
    };
  }

  // Phase 2: BM25 search over descriptor index
  const bm25Results = bm25SearchTools(query, 6);
  const discovered = bm25Results.map((r) => r.name);
  discoverTools(discovered, runId);

  return {
    matches: bm25Results.map(({ name, description }) => ({ name, description })),
    discovered,
    total_tools: Object.keys(toolRegistry).length,
  };
}
