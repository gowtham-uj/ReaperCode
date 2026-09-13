import { toolRegistry } from "../tools/registry.js";

const coreToolOrder = ["file_view", "list_directory", "grep_search", "write_file", "file_edit", "bash"] as const;

export interface ToolSearchOptions {
  catalog?: Record<string, { description: string }>;
  pinnedTools?: Record<string, number>;
  remainingTokenBudget?: number;
}

export interface PinnedToolState {
  toolName: string;
  ttl: number;
}

export function searchTools(query: string, options?: ToolSearchOptions): Array<{ name: string; description: string }> {
  const normalized = query.toLowerCase();


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

/**
 * How many description tokens must match before prose alone can suggest a tool.
 *
 * A single common English word appearing somewhere in a tool's description is
 * not evidence that the user wants that tool. Every prompt contains *something*
 * that substring-matches *some* description — "build" against a description
 * mentioning "git-backed ... before a risky mutation batch", "file" against
 * half the registry — and since the shortlist takes everything scoring above
 * zero, that was enough to attach unrelated tools to every turn.
 *
 * Two independent word matches is a real signal ("runtimes" *and* "package"
 * *and* "manifests" all point at `inspect_environment`); one is noise.
 */
const DESCRIPTION_TOKENS_NEEDED = 2;

/**
 * Below this length a word can still match a tool *name* but never a description.
 *
 * Tool names are a small curated vocabulary where "git" and "job" are real
 * words; descriptions are free prose where a three-letter match is always an
 * accident — "me", "do", "so", "up", "new" appear in almost every one.
 */
const DESCRIPTION_TOKEN_MIN_LENGTH = 4;

/**
 * Words that carry no capability signal.
 *
 * Without this, two description matches is trivially reachable on *any* prose:
 * "the", "and", "for", and "this" appear in nearly every tool description ever
 * written, so a prompt like "fetch the page and tell me the text" clears the
 * threshold against `hook_manager`. Only content words count.
 *
 * Kept deliberately small. A long list would start dropping real capability
 * words — "search", "list", "read", "write", and "run" all name things a tool
 * genuinely does — so this holds function words only.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old",
  "see", "two", "way", "who", "boy", "did", "use", "that", "this", "with", "from", "they",
  "have", "were", "been", "than", "then", "them", "each", "into", "only", "over", "such",
  "some", "when", "what", "which", "their", "there", "these", "those", "would", "could",
  "should", "about", "after", "again", "also", "back", "because", "before", "being",
  "between", "both", "does", "doing", "down", "during", "just", "like", "make", "made",
  "many", "more", "most", "much", "must", "never", "other", "same", "still", "tell",
  "under", "until", "very", "want", "well", "will", "your", "yours", "here", "where",
  "while", "why", "give", "given", "please", "thing", "things", "need", "needs",
]);

/**
 * Rank a tool against a query.
 *
 * Four rules, in order of how much they matter:
 *
 * 1. **An exact name match is certain.** The short circuit at the top is for
 *    `search_tools`' own `select:<name>` path, where the caller has already
 *    named what it wants.
 * 2. **Name matches dominate.** A word of the tool's name is the strongest
 *    ordinary signal, and it stands alone.
 * 3. **One description match is not enough.** Prose matches need
 *    `DESCRIPTION_TOKENS_NEEDED` of them to count at all, and below that the
 *    tool scores zero rather than merely ranking low — the shortlist takes
 *    everything above zero.
 * 4. **Short words and stopwords are skipped.** Function words appear in every
 *    description, and a three-letter match is always an accident.
 *
 * This scorer feeds two callers with different risk profiles, and the floor is
 * set for the riskier one. The pre-turn shortlist in `content-prep` attaches
 * its results to the wire whether or not the model asked, so a false positive
 * is paid on every subsequent call of the run. `search_tools` runs only because
 * the model asked, where a false positive costs one line in a list and the
 * ranking is already visible to the caller.
 */
export function scoreTool(name: string, description: string, query: string): number {
  const normalizedName = normalizeToolName(name);
  const normalizedDescription = description.toLowerCase();

  // Punctuation is stripped up front rather than per-token. Real prompts carry
  // it ("src/config.ts,", "do not."), and stripping only inside the loop left
  // the whole-query containment check below comparing against a string that
  // still had a trailing comma — so an exact tool name followed by a comma
  // scored zero.
  const cleanedQuery = query
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, " ")
    .trim();
  if (!cleanedQuery) return 0;
  if (normalizedName === cleanedQuery || name.toLowerCase() === cleanedQuery) return 100;

  const nameWords = normalizedName.split(/\s+/).filter(Boolean);
  let score = 0;

  if (normalizedName.includes(cleanedQuery) || name.toLowerCase().includes(cleanedQuery)) {
    score += 12;
  }

  let nameHits = 0;
  let descriptionHits = 0;
  const countedDescriptionTokens = new Set<string>();

  for (const token of cleanedQuery.split(/\s+/)) {
    if (token.length < 2) continue;
    // Stopwords are skipped for both name and description matching. A tool may
    // legitimately contain one (`list_directory`), but a prompt saying "list"
    // will still reach it through `search_tools`, and letting function words
    // score here is what makes every prompt match every tool.
    if (STOPWORDS.has(token)) continue;

    if (nameWords.includes(token)) {
      score += 8;
      nameHits += 1;
    } else if (token.length >= 3 && normalizedName.includes(token)) {
      // A fragment of a name word: "checkpoint" against "create checkpoint" is
      // a word match and already counted; "check" is a prefix and lands here.
      score += 5;
      nameHits += 1;
    }

    // Descriptions only accept words long enough to be a capability. Below
    // four characters the matches are all accidents — "me", "do", "so", "up"
    // appear in almost every description — and unlike a name, which is a short
    // curated vocabulary, a description is free prose with no such discipline.
    if (token.length < DESCRIPTION_TOKEN_MIN_LENGTH) continue;
    if (!countedDescriptionTokens.has(token) && normalizedDescription.includes(token)) {
      countedDescriptionTokens.add(token);
      descriptionHits += 1;
    }
  }

  // Description matches score only once the tool has enough of them to stand
  // on its own. Below that the tool is dropped rather than merely ranked low,
  // because the shortlist takes everything above zero.
  score += descriptionHits * 2;
  if (nameHits === 0 && descriptionHits < DESCRIPTION_TOKENS_NEEDED) return 0;

  return score;
}

export function normalizeToolName(name: string): string {
  return name
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}
