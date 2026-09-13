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
export function executeSearchTools(
  query: string,
  runId: string,
  disabledTools: ReadonlySet<string> = EMPTY_DISABLED,
): SearchToolsResult {
  ensureDescriptors();

  // A tool this thread has switched off must not be findable, let alone
  // promotable: `buildGeneralAgentTools` withholds it from the wire, so
  // answering a search with it would hand the model a schema it will then be
  // refused for using. Filtering the catalog rather than the results means the
  // `total_tools` count below agrees with what can actually be searched.
  const catalog = Object.entries(toolRegistry).filter(([name]) => !disabledTools.has(name));
  const normalized = query.toLowerCase().trim();
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
      total_tools: catalog.length,
    };
  }

  // Phase 2: BM25 search over descriptor index. The index is built from the
  // whole registry once, so a disabled tool can still rank; dropping anything
  // this thread has switched off is what keeps a search from advertising it.
  const bm25Results = bm25SearchTools(query, 6)
    .filter((result) => !disabledTools.has(result.name));
  const discovered = bm25Results.map((r) => r.name);
  discoverTools(discovered, runId);

  return {
    matches: bm25Results.map(({ name, description }) => ({ name, description })),
    discovered,
    total_tools: catalog.length,
  };
}

/** Shared empty set, so the common no-tools-disabled path allocates nothing. */
const EMPTY_DISABLED: ReadonlySet<string> = new Set<string>();
