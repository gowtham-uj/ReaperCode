import { buildCodebaseIndex, type CodebaseIndex } from "../context/indexer.js";
import { getCachedIndex, setCachedIndex } from "../context/cache.js";
import { compactToolHistory, type CompactedHistory } from "../context/history-compaction.js";
import { microcompact } from "../context/compaction/microcompact.js";
import { resolveMentions } from "../context/mentions.js";
import { prepareContext, type PreparedContext } from "../context/pruner.js";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "../context/skills.js";
import { packagedSkills } from "../context/packaged-skills.js";
import { readPinnedSkills, resolvePinnedSkills } from "../context/pinned-skills.js";
import { searchTools } from "../context/tool-search.js";
import { runMiddlewareChain, type MiddlewareDefinition } from "./middleware.js";
import { getEnvironmentFingerprint, type EnvironmentFingerprint } from "./fingerprint.js";
import type { ToolResult } from "../tools/types.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SwePrunerConfig } from "../context/swe-pruner.js";
import { ProjectTrustStore, resolveProjectTrusted, type ProjectTrustResolution } from "../resources/project-trust.js";
import { resolveResources, type ResolvedResources } from "../resources/resource-loader.js";
import { DefaultResourcePackageManager } from "../resources/package-manager.js";
import { loadContextFiles, type ContextFileLoadResult } from "../resources/context-files.js";

/**
 * Whether to skip the keyword pre-pass that pre-attaches tools to the wire.
 *
 * The pre-pass is an optimisation, not a mechanism: it looks at the user's
 * prompt and promotes any tool the wording happens to match, so a well-phrased
 * request arrives with the tool already attached and the model never has to go
 * looking. That is the right default. It is also why the discovery path is
 * hard to *test* — most prompts that would exercise `search_tools` never reach
 * it, because the pre-pass got there first.
 *
 * Setting this turns the shortcut off so every deferred tool stays deferrable.
 * Used by `scripts/verify-tool-discovery.mts` to prove the inventory →
 * `search_tools` → schema route independently of the pre-pass. Not a
 * product-facing option: nothing in the app sets it, and unset behaviour is
 * unchanged.
 */
function toolPrePassDisabled(): boolean {
  return process.env.REAPER_DISABLE_TOOL_PREPASS === "1";
}

export interface ContentPrepInput {
  workspaceRoot: string;
  userHome?: string;
  prompt: string;
  maxContextTokens: number;
  toolResults?: ToolResult[];
  compactToolResults?: boolean;
  latestVerificationFailure?: string;
  middlewares?: Array<MiddlewareDefinition<ContentPrepResult>>;
  prunerConfig?: SwePrunerConfig;
  backgroundProcesses?: Array<{ pid: number; status: "running" | "finished"; exitCode: number | null }>;
  /** Force a fresh workspace index at a run boundary. */
  forceIndexRefresh?: boolean;
}

export interface ContentPrepResult {
  index: CodebaseIndex;
  preparedContext: PreparedContext;
  compactedHistory: CompactedHistory;
  toolShortlist: Array<{ name: string; description: string }>;
  mentions: ReturnType<typeof resolveMentions>;
  skills: Skill[];
  skillsPrompt: string;
  /**
   * Skills whose full body is in this turn, without the model having asked.
   *
   * Two sources, and the field carries both because they are delivered the same
   * way: a human typed `/name` at the head of the prompt, or the skill is
   * pinned always-on in the user's settings. `pinned` is what tells them apart,
   * and it matters to the reader of the transcript — "I asked for this" and
   * "this is always here" are different facts about a turn.
   *
   * Carried on the result rather than folded into `skillsPrompt` so the
   * cockpit can give it its own section and its own authority label: the other
   * skills are names the model may ask about, these are instructions it has
   * already been given.
   */
  invokedSkills: Array<{ name: string; body: string; pinned?: boolean }>;
  contextFiles: ContextFileLoadResult;
  environmentFingerprint: EnvironmentFingerprint;
  resourceTrust: ProjectTrustResolution & { diagnostics: string[] };
  resources: ResolvedResources;
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

/**
 * A skill a human named on the first line of their message, with its body.
 *
 * `/codemode` in the composer or in `reaper exec --prompt` means "start this
 * turn with these instructions loaded", the same thing the model gets by
 * calling `activate_skill` — and the same body, read through the same
 * discovery walk, so the two cannot drift.
 *
 * Only the first token is considered, and only at the very start of the
 * message. That is what keeps this from firing on prose: `/usr/bin is
 * missing` and `run ls /tmp` both have a slash, and neither names a skill,
 * but a rule that looked anywhere in the message would load a body for one
 * of them the day somebody installed a skill called `usr`. A skill body is
 * an instruction — the one thing here that must never arrive by accident.
 *
 * An unknown name resolves to nothing rather than an error. The message is
 * still the user's message, and the model reads it either way; refusing the
 * turn because a slash command was mistyped would be worse than ignoring it.
 */
function resolveInvokedSkill(prompt: string, skills: readonly Skill[]): Array<{ name: string; body: string }> {
  const match = /^\s*\/([A-Za-z0-9._-]+)(?=\s|$)/.exec(prompt);
  const name = match?.[1];
  if (!name) return [];
  /*
   * Exact match first, then case-insensitive. Skill names are lowercase by
   * schema, but a user-installed skill's name can come from its frontmatter or
   * its folder, so the exact spelling is the one that must keep working.
   */
  const skill =
    skills.find((candidate) => candidate.name === name) ??
    skills.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!skill) return [];
  /*
   * Read the body from the file the summary the model was shown came from, so
   * "which skill did I just load?" has one answer. Packaged skills are in the
   * same list with the same field, which is why this does not need to know
   * which half a skill came from.
   *
   * `disableModelInvocation` is honoured here too: a skill an operator has
   * silenced must not become readable by typing its name.
   */
  if (skill.disableModelInvocation) return [];
  const body = readSkillBody(skill.filePath);
  // The skill's own name, not the spelling that was typed: everything
  // downstream keys on it, and two spellings of one skill is a bug waiting.
  return body ? [{ name: skill.name, body }] : [];
}

/**
 * The markdown body of a skill file, frontmatter stripped. Never throws.
 *
 * Duplicated in `context/pinned-skills.ts` for the same reason it was written
 * twice here rather than imported once: the two are the same four lines, and
 * the alternative is a module depending on `runtime/` for a helper that has
 * nothing to do with the runtime.
 */
function readSkillBody(filePath: string): string | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const withoutFrontmatter = raw.startsWith("---\n")
      ? (() => {
          const end = raw.indexOf("\n---\n", 4);
          return end === -1 ? raw : raw.slice(end + 5);
        })()
      : raw;
    const body = withoutFrontmatter.trim();
    return body.length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
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
    `h:${input.userHome ?? ""}`,
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
  const useCache = options.memoize === true && !input.middlewares;
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
  const index = await getOrBuildIndex(
    input.workspaceRoot,
    input.forceIndexRefresh === true || hasSuccessfulWorkspaceWrite(input.toolResults ?? []),
  );
  const environmentFingerprint = await environmentFingerprintPromise;
  const mentions = resolveMentions(input.prompt);
  const preparedContext = await prepareContext({
    index,
    prompt: input.prompt,
    mentions,
    maxTokens: input.maxContextTokens,
  });

  // Always microcompact to keep tool result outputs bounded
  const microcompacted = microcompact({ toolResults: input.toolResults ?? [] });

  const compactedHistory = compactToolHistory({
    maxEntries: input.compactToolResults ? 20 : Number.MAX_SAFE_INTEGER,
    toolResults: microcompacted.toolResults,
    ...(input.latestVerificationFailure ? { latestVerificationFailure: input.latestVerificationFailure } : {}),
  });

  const userHome = input.userHome ?? process.env.HOME ?? process.cwd();
  const resourceTrustBase = await resolveProjectTrusted({
    workspaceRoot: input.workspaceRoot,
    store: ProjectTrustStore.create(userHome),
    defaultDecision: "never",
  });
  const resourceTrust = {
    ...resourceTrustBase,
    diagnostics: resourceTrustBase.requiresTrust && !resourceTrustBase.trusted
      ? ["Project resources exist but are not trusted; project extensions/hooks/packages/prompts were not loaded."]
      : [],
  };
  const resources = resourceTrust.trusted
    ? await resolveResources({
        workspaceRoot: input.workspaceRoot,
        userHome,
        packages: new DefaultResourcePackageManager({
          workspaceRoot: input.workspaceRoot,
          userHome,
          runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }).resolvePackageResourceInputs(),
      })
    : { extensions: [], skills: [], prompts: [], themes: [] };
  /*
   * Packaged skills are merged in rather than gated on project trust.
   *
   * The trust gate is about *project* content: a `.reaper/skills` folder in a
   * repo the user has not trusted is attacker-controlled text, and loading it
   * would let a repository write the agent's instructions. A skill that ships
   * inside the binary is neither project content nor attacker-controlled, and
   * gating it on a workspace flag would mean the product's own skills are
   * absent in exactly the fresh-workspace case they were written for.
   */
  const skills = [...packagedSkills(), ...(resourceTrust.trusted ? discoverSkills(input.workspaceRoot) : [])];
  const skillsPrompt = formatSkillsForPrompt(skills, input.prompt);
  /*
   * Two ways a body enters the turn without the model asking for it: a human
   * typed `/name`, and a skill is pinned always-on. Both resolve against the
   * *same* filtered list the model was offered, which is what keeps pinning
   * from reaching past the project-trust gate that produced it.
   *
   * A skill that is both pinned and named in this turn appears once. The
   * invocation is the more specific statement — the human said "this one, now"
   * — so it keeps its position and its `user_instruction` authority, and the
   * pin simply does not add a second copy.
   */
  const invoked = resolveInvokedSkill(input.prompt, skills);
  const invokedNames = new Set(invoked.map((entry) => entry.name));
  const pinned = resolvePinnedSkills(readPinnedSkills(userHome), skills)
    .filter((entry) => !invokedNames.has(entry.name))
    .map((entry) => ({ ...entry, pinned: true }));
  const invokedSkills = [...invoked, ...pinned];

  const contextFiles = await loadContextFiles({
    workspaceRoot: input.workspaceRoot,
    userHome,
    trusted: resourceTrust.trusted,
  });

  const base: ContentPrepResult = {
    index,
    preparedContext,
    compactedHistory,
    toolShortlist: toolPrePassDisabled()
      ? []
      : searchTools(input.prompt, {
          remainingTokenBudget: input.maxContextTokens,
        }),
    mentions,
    skills,
    skillsPrompt,
    invokedSkills,
    contextFiles,
    resourceTrust,
    resources,
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
    invokedSkills: z.array(z.any()),
    contextFiles: z.any(),
    resourceTrust: z.any(),
    resources: z.any(),
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
      if (["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name)) return true;
      if (result.name === "bash") {
        const args = (result.args ?? {}) as { cmd?: unknown; command?: unknown };
        const cmd = typeof args.cmd === "string"
          ? args.cmd
          : typeof args.command === "string"
            ? args.command
            : "";
        return /\b(?:mkdir|touch|rm|mv|cp|npm|yarn|pnpm|bun|cargo|pip|poetry|go|prisma|npx|generate)\b|\bsed\b[^;&|]*\s-i\b|\bperl\b[^;&|]*\s-[^\s]*i\b|(?:^|[^<>])>{1,2}[^&]|\btee\s+/i.test(cmd);
      }
      return false;
    }
  );
}
