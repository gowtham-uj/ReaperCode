/**
 * F5: conditional skill activation by file path.
 *
 * Skills may declare `pathPatterns: string[]` (already a ReaperSkill
 * field on the type) describing glob patterns relative to the
 * workspace. When a run touches a file matching one of those
 * patterns, the corresponding skill is "activated" for the rest of
 * the run. This module scans the registry and returns the set of
 * skills whose patterns match the supplied paths.
 *
 * The matching is intentionally simple: a `*` wildcard and a `/`
 * segment separator. We do not bring in a full glob library because
 * the use case is "does this skill ever apply?".
 */

import type { ReaperSkill } from "./types.js";
import { SkillMemoryRegistry } from "./skill-memory-registry.js";

/** Convert a simple glob to a RegExp. Supports `*` (any segment)
 *  and `**` (any path, including zero segments). */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // `**/` should match "zero or more directories" — handle the
    // common leading `**/` case explicitly.
    .replace(/\*\*\//g, "::DOUBLESTARSLASH::")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTARSLASH::/g, "(.*\\/)?")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function pathMatches(workspaceRoot: string, candidate: string, pattern: string): boolean {
  // Patterns are slash-separated and relative to workspaceRoot. Normalize
  // native Windows paths before stripping the workspace prefix.
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  const rel = normalizedCandidate.startsWith(`${root}/`)
    ? normalizedCandidate.slice(root.length + 1)
    : normalizedCandidate.replace(/^\.\//, "");
  return globToRegExp(pattern.replace(/\\/g, "/").replace(/^\.\//, "")).test(rel);
}

/**
 * Return the names of registered skills whose `pathPatterns` (if
 * any) match at least one of the supplied absolute or relative file
 * paths. The order of the returned list is the registry's order,
 * which is insertion order.
 */
export function activateConditionalSkillsForPaths(input: {
  workspaceRoot: string;
  paths: string[];
  skills?: ReaperSkill[];
}): string[] {
  const skills = input.skills ?? new SkillMemoryRegistry({ workspaceRoot: input.workspaceRoot }).listSkills();
  const matches: string[] = [];
  for (const skill of skills) {
    const patterns = (skill as ReaperSkill & { pathPatterns?: string[] }).pathPatterns;
    if (!patterns || patterns.length === 0) continue;
    for (const p of input.paths) {
      if (patterns.some((pat) => pathMatches(input.workspaceRoot, p, pat))) {
        matches.push(skill.name);
        break;
      }
    }
  }
  return matches;
}
