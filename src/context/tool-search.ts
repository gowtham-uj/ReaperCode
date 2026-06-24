import { toolRegistry } from "../tools/registry.js";
import type { MergedToolRegistry } from "../tools/mcp/registry.js";

const coreToolOrder = ["read_file", "list_directory", "grep_search", "write_file", "replace_in_file", "run_shell_command"] as const;

export interface ToolSearchOptions {
  catalog?: Record<string, { description: string }>;
  pinnedTools?: Record<string, number>;
  mcpRegistry?: MergedToolRegistry;
  remainingTokenBudget?: number;
}

export interface PinnedToolState {
  toolName: string;
  ttl: number;
}

export function searchTools(query: string, options?: ToolSearchOptions): Array<{ name: string; description: string }> {
  const normalized = query.toLowerCase();

  // If MCP registry is available, use it for active set selection
  if (options?.mcpRegistry) {
    const activeTools = options.mcpRegistry.advanceTurn(query, options.remainingTokenBudget ?? 50000);
    return activeTools.map((t) => ({ name: t.name, description: t.description }));
  }

  // Fallback: static registry
  const fullCatalog = { ...toolRegistry, ...(options?.catalog ?? {}) };

  const ranked = Object.entries(fullCatalog)
    .map(([name, spec]) => ({ name, description: spec.description, score: scoreTool(name, spec.description, normalized) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)));

  const selected = new Map<string, { name: string; description: string }>();

  for (const name of coreToolOrder) {
    const spec = fullCatalog[name as keyof typeof fullCatalog] ?? { description: "" };
    selected.set(name, { name, description: spec.description });
  }

  if (options?.pinnedTools) {
    for (const [name, ttl] of Object.entries(options.pinnedTools)) {
      if (ttl > 0 && !selected.has(name) && fullCatalog[name as keyof typeof fullCatalog]) {
        selected.set(name, { name, description: fullCatalog[name as keyof typeof fullCatalog]!.description });
      }
    }
  }

  for (const item of ranked) {
    if (item.score <= 0 || selected.has(item.name)) continue;
    selected.set(item.name, { name: item.name, description: item.description });
    if (selected.size >= 8) break;
  }

  return Array.from(selected.values()).slice(0, 8);
}

export function decayPinnedTools(pinnedTools: Record<string, number>, usedTools: string[]): Record<string, number> {
  const nextPinned: Record<string, number> = {};
  
  // Decrease TTL for all existing pinned tools
  for (const [name, ttl] of Object.entries(pinnedTools)) {
    if (ttl > 1) {
      nextPinned[name] = ttl - 1;
    }
  }

  // Refresh or add TTL for recently used tools (e.g. TTL = 3 turns)
  for (const name of usedTools) {
    nextPinned[name] = 3;
  }

  return nextPinned;
}

export function scoreTool(name: string, description: string, query: string): number {
  const normalizedName = normalizeToolName(name);
  const normalizedDescription = description.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;
  if (normalizedName === normalizedQuery || name.toLowerCase() === normalizedQuery) return 100;

  let score = 0;
  if (normalizedName.includes(normalizedQuery) || name.toLowerCase().includes(normalizedQuery)) {
    score += 12;
  }
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  for (const token of terms) {
    if (!token) {
      continue;
    }
    if (normalizedName.split(/\s+/).includes(token)) {
      score += 8;
    } else if (normalizedName.includes(token) || name.toLowerCase().includes(token)) {
      score += 5;
    }
    if (normalizedDescription.includes(token)) {
      score += 2;
    }
  }
  return score;
}

export function normalizeToolName(name: string): string {
  return name
    .replace(/^mcp__/, "")
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}
