/**
 * context/supersede-prune.ts — drop stale tool results when a later call
 * supersedes them (OMP `pruneStaleToolResults` port).
 *
 * Rules:
 * 1. When the same file path is re-read (`file_view` / `read_file` / `view_file`),
 *    earlier read results for that path are replaced with a short placeholder.
 * 2. Results flagged `useless: true` (or meta.useless) are always pruned,
 *    even inside the protect window.
 * 3. Prompt-cache guard: never mutate messages inside the warm prefix
 *    (first `warmPrefixCount` messages, default 1 = cockpit). Callers can
 *    raise this when they know a longer prefix is cached.
 */

export interface SupersedePruneOptions {
  /** Number of leading messages to leave untouched (prompt-cache warm prefix). Default 1. */
  warmPrefixCount?: number;
  /** Placeholder for superseded reads. */
  supersededPlaceholder?: string;
  /** Placeholder for useless-flagged results. */
  uselessPlaceholder?: string;
}

export interface SupersedePruneResult {
  pruned: number;
  savedChars: number;
  performed: boolean;
}

const READ_TOOLS = new Set(["file_view", "read_file", "view_file", "file_scroll"]);
const DEFAULT_SUPERSEDED = "[superseded: file re-read later]";
const DEFAULT_USELESS = "[useless tool result pruned]";

function extractPathFromArgs(args: unknown): string | null {
  if (!args) return null;
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const p = rec.path ?? rec.file ?? rec.file_path ?? rec.filename;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function findToolMeta(
  messages: Array<Record<string, unknown>>,
  toolIdx: number,
): { name: string; args?: unknown; useless?: boolean } {
  const toolMsg = messages[toolIdx];
  const callId = typeof toolMsg?.tool_call_id === "string" ? toolMsg.tool_call_id : undefined;
  let name = "tool";
  let args: unknown;
  if (callId) {
    for (let i = toolIdx - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        if (tc.id !== callId) continue;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.name === "string") name = fn.name;
        if (fn) args = fn.arguments;
        break;
      }
      if (name !== "tool") break;
    }
  }
  const useless =
    toolMsg?.useless === true ||
    (toolMsg?.meta !== undefined &&
      typeof toolMsg.meta === "object" &&
      toolMsg.meta !== null &&
      (toolMsg.meta as Record<string, unknown>).useless === true);
  return { name, args, ...(useless ? { useless: true as const } : {}) };
}

/**
 * Mutates `messages` in place. Safe to call every turn — already-pruned
 * placeholders are skipped.
 */
export function pruneSupersededToolResults(
  messages: Array<Record<string, unknown>>,
  options: SupersedePruneOptions = {},
): SupersedePruneResult {
  const warmPrefixCount = Math.max(0, options.warmPrefixCount ?? 1);
  const supersededPlaceholder = options.supersededPlaceholder ?? DEFAULT_SUPERSEDED;
  const uselessPlaceholder = options.uselessPlaceholder ?? DEFAULT_USELESS;

  // Collect read tool results by path (newest last).
  const readsByPath = new Map<string, number[]>();
  const uselessIndices: number[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    if (i < warmPrefixCount) continue;
    const msg = messages[i];
    if (!msg || msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.startsWith("[") && content.endsWith("]")) continue;

    const meta = findToolMeta(messages, i);
    if (meta.useless) {
      uselessIndices.push(i);
      continue;
    }
    if (!READ_TOOLS.has(meta.name)) continue;
    const filePath = extractPathFromArgs(meta.args);
    if (!filePath) continue;
    const list = readsByPath.get(filePath) ?? [];
    list.push(i);
    readsByPath.set(filePath, list);
  }

  let pruned = 0;
  let savedChars = 0;

  for (const indices of readsByPath.values()) {
    if (indices.length < 2) continue;
    // Keep the newest; prune older ones.
    const older = indices.slice(0, -1);
    for (const idx of older) {
      const msg = messages[idx];
      if (!msg) continue;
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content === supersededPlaceholder) continue;
      savedChars += Math.max(0, content.length - supersededPlaceholder.length);
      msg.content = supersededPlaceholder;
      pruned += 1;
    }
  }

  for (const idx of uselessIndices) {
    const msg = messages[idx];
    if (!msg) continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content === uselessPlaceholder) continue;
    savedChars += Math.max(0, content.length - uselessPlaceholder.length);
    msg.content = uselessPlaceholder;
    pruned += 1;
  }

  return { pruned, savedChars, performed: pruned > 0 };
}
