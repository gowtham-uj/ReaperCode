/**
 * SkillRouter — relevance ranking for skills. Picks the top-N skills
 * relevant to the current run, returns `SkillSummary` objects only.
 *
 * Crucial invariant: the router NEVER returns skill bodies. Bodies
 * are only read by the hardened `activate_skill` tool, which already
 * enforces a registry allowlist + `disableModelInvocation` guard.
 * This keeps skill content out of the model's prompt by default.
 *
 * Scoring (highest first):
 *   1. `triggers` keyword match against `query` (+3 per match, cap 6)
 *   2. `pathPatterns` glob match against `paths` (+4 per match)
 *   3. `lastValidatedAt` recency (+1 if within 7 days)
 *   4. Trust tier boost (builtin +2, user-trusted +1, extension-inherited +1,
 *      project-untrusted 0, draft excluded)
 *
 * The router is a pure function over its inputs. It does not read
 * disk; the caller passes in candidates.
 */

import type { InstalledSkillRecord, SkillSummary, SkillTrust } from "./types.js";

export interface SkillRouterInput {
  /** The user's current prompt / task description. */
  query: string;
  /** File paths the run has touched recently (absolute paths). */
  paths?: string[];
  /** Candidate skill records (any trust level). */
  candidates: InstalledSkillRecord[];
  /** Max results to return. Default 5. */
  n?: number;
  /** Workspace root for path-pattern globbing. */
  workspaceRoot?: string;
}

const DEFAULT_TOP_N = 5;
const TRIGGER_HIT_CAP = 6;
const PATH_HIT_BOOST = 4;
const TRIGGER_HIT_BOOST = 3;
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TRUST_BOOST: Record<SkillTrust, number> = {
  "builtin": 2,
  "user-trusted": 1,
  "extension-inherited": 1,
  "project-untrusted": 0,
  "draft": -Infinity,
};

export class SkillRouter {
  /** Return the top-N most relevant skills as summaries (no body). */
  selectTopN(input: SkillRouterInput): SkillSummary[] {
    const n = input.n ?? DEFAULT_TOP_N;
    const queryTokens = tokenize(input.query);
    const paths = input.paths ?? [];
    const scored: SkillSummary[] = [];
    for (const c of input.candidates) {
      if (c.trust === "draft") continue;
      const trustBoost = TRUST_BOOST[c.trust];
      if (trustBoost === -Infinity) continue;
      const matchedTriggers = matchTriggers(c, queryTokens);
      const matchedPaths = matchPaths(c, paths, input.workspaceRoot);
      const recencyBoost = isRecent(c) ? 1 : 0;
      const score =
        Math.min(matchedTriggers.length, TRIGGER_HIT_CAP / TRIGGER_HIT_BOOST) * TRIGGER_HIT_BOOST +
        matchedPaths.length * PATH_HIT_BOOST +
        recencyBoost +
        trustBoost;
      if (score <= 0) continue;
      scored.push({
        name: c.manifest.name,
        description: c.manifest.description,
        category: c.manifest.category,
        trust: c.trust,
        score,
        matchedTriggers: matchedTriggers.slice(0, TRIGGER_HIT_CAP / TRIGGER_HIT_BOOST).map((t) => t),
        matchedPaths,
        recencyBoost: recencyBoost > 0,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }

  /**
   * Render a short markdown block listing the selected skill summaries.
   * Intended for injection into the system prompt — never includes
   * bodies, only one line per skill.
   */
  renderForPrompt(summaries: SkillSummary[]): string {
    if (summaries.length === 0) return "";
    const lines: string[] = ["# Relevant skills (summaries only — call activate_skill to load a body)"];
    for (const s of summaries) {
      const triggers = s.matchedTriggers.length > 0 ? ` triggers=${s.matchedTriggers.join("|")}` : "";
      const paths = s.matchedPaths.length > 0 ? ` paths=${s.matchedPaths.join("|")}` : "";
      const recency = s.recencyBoost ? " recent" : "";
      lines.push(`- ${s.name} [${s.category}, ${s.trust}] score=${s.score}${triggers}${paths}${recency}: ${s.description}`);
    }
    return lines.join("\n");
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/g)
    .filter((t) => t.length > 1);
}

function matchTriggers(c: InstalledSkillRecord, queryTokens: string[]): string[] {
  const triggers = c.manifest.triggers ?? [];
  if (triggers.length === 0 || queryTokens.length === 0) return [];
  const matched: string[] = [];
  for (const t of triggers) {
    const tTokens = tokenize(t);
    if (tTokens.length === 0) continue;
    // Match if any token in the trigger appears in the query OR if any
    // trigger token equals the name / description.
    const hit = tTokens.some((tt) => queryTokens.includes(tt))
      || queryTokens.some((qt) => tTokens.includes(qt))
      || queryTokens.some((qt) => c.manifest.name.includes(qt))
      || queryTokens.some((qt) => c.manifest.description.toLowerCase().includes(qt));
    if (hit) matched.push(t);
  }
  return matched;
}

function matchPaths(c: InstalledSkillRecord, paths: string[], workspaceRoot?: string): string[] {
  const patterns = c.manifest.pathPatterns ?? [];
  if (patterns.length === 0 || paths.length === 0) return [];
  const matched: string[] = [];
  for (const pat of patterns) {
    const re = globToRegExp(pat);
    for (const p of paths) {
      const rel = workspaceRoot && p.startsWith(workspaceRoot + "/")
        ? p.slice(workspaceRoot.length + 1)
        : p;
      if (re.test(rel)) {
        matched.push(pat);
        break;
      }
    }
  }
  return matched;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "::DOUBLESTARSLASH::")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTARSLASH::/g, "(.*\\/)?")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isRecent(c: InstalledSkillRecord): boolean {
  if (!c.lastValidatedAt) return false;
  return Date.now() - c.lastValidatedAt < RECENCY_WINDOW_MS;
}
