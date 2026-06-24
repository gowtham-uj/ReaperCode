import { buildCodebaseIndex, type CodebaseIndex } from "../context/indexer.js";
import { getCachedIndex, setCachedIndex } from "../context/cache.js";
import { compactToolHistory, type CompactedHistory } from "../context/history-compaction.js";
import { microcompact } from "../context/compaction/microcompact.js";
import { resolveMentions } from "../context/mentions.js";
import { prepareContext, type PreparedContext } from "../context/pruner.js";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "../context/skills.js";
import { searchTools } from "../context/tool-search.js";
import { runMiddlewareChain, type MiddlewareDefinition } from "./middleware.js";
import { getEnvironmentFingerprint, type EnvironmentFingerprint } from "./fingerprint.js";
import type { ToolResult } from "../tools/types.js";
import { z } from "zod";
import type { SwePrunerConfig } from "../context/swe-pruner.js";
import type { MergedToolRegistry } from "../tools/mcp/registry.js";

export interface ContentPrepInput {
  workspaceRoot: string;
  prompt: string;
  maxContextTokens: number;
  toolResults?: ToolResult[];
  compactToolResults?: boolean;
  latestVerificationFailure?: string;
  middlewares?: Array<MiddlewareDefinition<ContentPrepResult>>;
  prunerConfig?: SwePrunerConfig;
  backgroundProcesses?: Array<{ pid: number; status: "running" | "finished"; exitCode: number | null }>;
  mcpRegistry?: MergedToolRegistry;
}

export interface ContentPrepResult {
  index: CodebaseIndex;
  preparedContext: PreparedContext;
  compactedHistory: CompactedHistory;
  toolShortlist: Array<{ name: string; description: string }>;
  mentions: ReturnType<typeof resolveMentions>;
  skills: Skill[];
  skillsPrompt: string;
  environmentFingerprint: EnvironmentFingerprint;
  backgroundProcesses?: Array<{ pid: number; status: "running" | "finished"; exitCode: number | null }>;
}

/**
 * Per-process memoization for `prepareRuntimeContent`. Keyed on the
 * inputs that, when unchanged, guarantee the same output:
 *   - `workspaceRoot` (filesystem-bound)
 *   - `prompt` (the user's intent)
 *   - `maxContextTokens` (output budget)
 *   - `compactToolResults` flag
 *   - `latestVerificationFailure` (a string, feeds into compaction)
 *   - `toolResults` (hashed — the per-turn history)
 *   - `backgroundProcesses` (hashed — the live process list)
 *   - `prunerConfig` (frozen config; we JSON-stringify it)
 *
 * We deliberately skip `middlewares` (may be stateful and add
 * side-effects) and skip when `mcpRegistry` is supplied (the registry
 * can have tools added/removed between calls — caching the tool
 * shortlist would be unsound).
 *
 * The cache is bounded to avoid unbounded growth on long-lived
 * processes; once `MAX_CACHE_SIZE` is hit the oldest entry is
 * dropped. Calls explicitly opt in by passing `memoize: true` so
 * callers that depend on side effects (filesystem scans, fingerprint
 * exec) opt out by default. Test code calls
 * `clearContentPrepCache()` between cases.
 */
interface ContentPrepCacheEntry {
  key: string;
  result: ContentPrepResult;
  insertedAt: number;
}

const CONTENT_PREP_CACHE: ContentPrepCacheEntry[] = [];
const MAX_CACHE_SIZE = 32;

export function clearContentPrepCache(): void {
  CONTENT_PREP_CACHE.length = 0;
}

export function contentPrepCacheSize(): number {
  return CONTENT_PREP_CACHE.length;
}

/** FNV-1a 32-bit hash — fast, no crypto dep, plenty for a cache key. */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime multiplication, kept within 32 bits via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function hashToolResults(results: ToolResult[] | undefined): string {
  if (!results || results.length === 0) return "0";
  // Hash only name + ok + a fingerprint of the output. Output can be
  // large (multi-KB shell stdout); we cap the per-result fingerprint
  // at 256 chars to keep the hash cheap.
  let h = `${results.length}:`;
  for (const r of results) {
    const out = r.output;
    let outFp = "";
    if (typeof out === "string") {
      outFp = out.length > 256 ? `s${out.length}:${out.slice(0, 64)}${out.slice(-64)}` : `s${out.length}:${out}`;
    } else if (out && typeof out === "object") {
      try {
        const j = JSON.stringify(out);
        outFp = j.length > 256 ? `j${j.length}:${j.slice(0, 64)}${j.slice(-64)}` : `j${j.length}:${j}`;
      } catch {
        outFp = "u";
      }
    } else {
      outFp = "n";
    }
    h += `${r.name}|${r.ok ? 1 : 0}|${outFp};`;
  }
  return fnv1a(h);
}

function hashBackgroundProcesses(
  procs: Array<{ pid: number; status: "running" | "finished"; exitCode: number | null }> | undefined,
): string {
  if (!procs || procs.length === 0) return "0";
  return fnv1a(procs.map((p) => `${p.pid}:${p.status}:${p.exitCode ?? ""}`).join("|"));
}

function hashPrunerConfig(cfg: SwePrunerConfig | undefined): string {
  if (!cfg) return "0";
  try {
    return fnv1a(JSON.stringify(cfg));
  } catch {
    return "u";
  }
}

function buildCacheKey(input: ContentPrepInput): string {
  return [
    input.workspaceRoot,
    `p:${input.prompt.length}:${fnv1a(input.prompt)}`,
    `t:${input.maxContextTokens}`,
    `c:${input.compactToolResults ? 1 : 0}`,
    `v:${input.latestVerificationFailure ?? ""}`,
    `r:${hashToolResults(input.toolResults)}`,
    `b:${hashBackgroundProcesses(input.backgroundProcesses)}`,
    `u:${hashPrunerConfig(input.prunerConfig)}`,
  ].join("||");
}

function getCached(key: string): ContentPrepResult | undefined {
  const hit = CONTENT_PREP_CACHE.find((e) => e.key === key);
  return hit?.result;
}

function putCached(key: string, result: ContentPrepResult): void {
  CONTENT_PREP_CACHE.push({ key, result, insertedAt: Date.now() });
  if (CONTENT_PREP_CACHE.length > MAX_CACHE_SIZE) {
    CONTENT_PREP_CACHE.shift();
  }
}

export async function prepareRuntimeContent(
  input: ContentPrepInput,
  options: { memoize?: boolean } = {},
): Promise<ContentPrepResult> {
  // Memoization is opt-in: callers that explicitly need fresh
  // filesystem / fingerprint state pass `memoize: false`. The engine
  // passes `memoize: true` because retry / replay loops re-drive
  // this function with identical inputs.
  const useCache = options.memoize === true && !input.mcpRegistry && !input.middlewares;
  if (useCache) {
    const key = buildCacheKey(input);
    const hit = getCached(key);
    if (hit) return hit;
    const result = await computeContentPrep(input);
    putCached(key, result);
    return result;
  }
  return computeContentPrep(input);
}

async function computeContentPrep(input: ContentPrepInput): Promise<ContentPrepResult> {
  // Kick off the environment fingerprint in parallel with the index
  // build. The fingerprint shells out to 27 `command -v` calls (now
  // async + concurrent + cached); the index build walks the workspace
  // tree. Both are independent; running them concurrently shaves
  // hundreds of ms off the cold path.
  const environmentFingerprintPromise = getEnvironmentFingerprint(input.workspaceRoot);
  const index = await getOrBuildIndex(input.workspaceRoot, hasSuccessfulWorkspaceWrite(input.toolResults ?? []));
  const environmentFingerprint = await environmentFingerprintPromise;
  const mentions = resolveMentions(input.prompt);
  const preparedContext = await prepareContext({
    index,
    prompt: input.prompt,
    mentions,
    maxTokens: input.maxContextTokens,
    ...(input.prunerConfig ? { prunerConfig: input.prunerConfig } : {}),
  });

  // Always microcompact to keep tool result outputs bounded
  const microcompacted = microcompact({ toolResults: input.toolResults ?? [] });

  const compactedHistory = compactToolHistory({
    maxEntries: input.compactToolResults ? 20 : Number.MAX_SAFE_INTEGER,
    toolResults: microcompacted.toolResults,
    ...(input.latestVerificationFailure ? { latestVerificationFailure: input.latestVerificationFailure } : {}),
  });

  const skills = discoverSkills(input.workspaceRoot);
  const skillsPrompt = formatSkillsForPrompt(skills, input.prompt);

  const base = {
    index,
    preparedContext,
    compactedHistory,
    toolShortlist: searchTools(input.prompt, {
      ...(input.mcpRegistry ? { mcpRegistry: input.mcpRegistry } : {}),
      remainingTokenBudget: input.maxContextTokens,
    }),
    mentions,
    skills,
    skillsPrompt,
    environmentFingerprint: await environmentFingerprintPromise,
    ...(input.backgroundProcesses ? { backgroundProcesses: input.backgroundProcesses } : {}),
  };

  const validator = z.object({
    index: z.any(),
    preparedContext: z.any(),
    compactedHistory: z.any(),
    toolShortlist: z.array(z.object({ name: z.string(), description: z.string() })),
    mentions: z.object({ fileMentions: z.array(z.string()), symbolMentions: z.array(z.string()) }),
    skills: z.array(z.any()),
    skillsPrompt: z.string(),
    environmentFingerprint: z.any(),
    backgroundProcesses: z.array(z.object({ pid: z.number(), status: z.string(), exitCode: z.number().nullable() })).optional(),
  }) as unknown as z.ZodType<ContentPrepResult>;

  const middlewareResult = await runMiddlewareChain({
    workspaceRoot: input.workspaceRoot,
    hook: "onContentPrep",
    state: base,
    ...(input.middlewares ? { middlewares: input.middlewares } : {}),
    validator,
  });

  return middlewareResult.state;
}

async function getOrBuildIndex(workspaceRoot: string, forceRefresh: boolean): Promise<CodebaseIndex> {
  const cached = getCachedIndex(workspaceRoot);
  if (cached && !forceRefresh) {
    return cached;
  }

  const nextIndex = await buildCodebaseIndex(workspaceRoot);
  if (cached && cached.fingerprint === nextIndex.fingerprint) {
    return cached;
  }

  setCachedIndex(nextIndex);
  return nextIndex;
}

function hasSuccessfulWorkspaceWrite(toolResults: ToolResult[]): boolean {
  return toolResults.some(
    (result) => {
      if (!result.ok) return false;
      if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return true;
      if (result.name === "run_shell_command" && typeof result.output === "object" && result.output !== null) {
        const cmd = (result.output as any).cmd?.toLowerCase() || "";
        return /\b(mkdir|touch|rm|mv|cp|npm|yarn|pnpm|cargo|pip|go|prisma|npx|generate)\b/.test(cmd);
      }
      return false;
    }
  );
}
