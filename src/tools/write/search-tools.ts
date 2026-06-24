import type { z } from "zod";
import { toolRegistry } from "../registry.js";
import { normalizeToolName, scoreTool } from "../../context/tool-search.js";
import { discoverTools } from "../discovery.js";
import { SearchToolsArgsSchema } from "../types.js";

export { SearchToolsArgsSchema };

export type SearchToolsArgs = z.infer<typeof SearchToolsArgsSchema>;

export interface SearchToolsResult {
  matches: Array<{ name: string; description: string }>;
  discovered: string[];
  total_tools: number;
}

/**
 * Search the tool registry by keyword and promote matches to full-schema rendering.
 * The model calls this when it needs a capability not in the core tool set.
 */
export function executeSearchTools(query: string, runId: string): SearchToolsResult {
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

  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of normalized.split(/\s+/).filter(Boolean)) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }
  const searchText = [...requiredTerms, ...optionalTerms].join(" ");

  const scored = catalog
    .filter(([name, spec]) => {
      if (requiredTerms.length === 0) return true;
      const haystack = `${name.toLowerCase()} ${normalizeToolName(name)} ${spec.description.toLowerCase()}`;
      return requiredTerms.every((term) => haystack.includes(term));
    })
    .map(([name, spec]) => ({
      name,
      description: spec.description,
      score: scoreTool(name, spec.description, searchText),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const discovered = scored.map((s) => s.name);
  discoverTools(discovered, runId);

  return {
    matches: scored.map(({ name, description }) => ({ name, description })),
    discovered,
    total_tools: Object.keys(toolRegistry).length,
  };
}
