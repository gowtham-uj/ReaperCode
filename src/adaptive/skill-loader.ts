/**
 * F3: directory-aware skill loader.
 *
 * Walks a skill directory recursively, returns one entry per skill
 * found. The walker respects a few conventions:
 *   - A `SKILL.md` at a directory is a skill boundary; the walker
 *     does NOT descend further.
 *   - Top-level `*.md` files (no subdirectory) are individual skills.
 *   - `.gitignore`, `.ignore`, `.fdignore` files are honored when
 *     present (basic glob matching; full gitignore semantics are
 *     out of scope here).
 *
 * The returned list is the *file* surface; callers hand entries to
 * `parseSkillFromRaw` to get a `ReaperSkill`. This separation lets
 * us cache file discovery without re-parsing frontmatter.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ReaperSkill, SkillScope } from "./types.js";
import { parseSkillFromRaw } from "./skill-author.js";

export interface SkillLoaderEntry {
  /** Skill name, derived from filename or frontmatter. */
  name: string;
  /** Absolute path to the SKILL.md / .md file. */
  path: string;
  /** Raw file content. */
  content: string;
  /** The scope that this entry was loaded from. */
  scope: SkillScope;
}

export interface LoadSkillsFromDirOptions {
  /** Root directory to walk. */
  root: string;
  /** Scope to tag the entries with. */
  scope: SkillScope;
  /** Optional list of ignore patterns. If omitted, the loader
   *  checks for `.gitignore`/`.ignore`/`.fdignore` in the root. */
  ignoreFiles?: string[];
  /** Optional max recursion depth. Default 6. */
  maxDepth?: number;
}

/** Read a small file and return its non-comment, non-blank lines. */
function readIgnoreFile(path: string): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function shouldIgnore(rel: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p) continue;
    if (p.endsWith("/")) {
      if (rel === p.slice(0, -1) || rel.startsWith(p)) return true;
    } else {
      if (rel === p || rel.endsWith(sep + p)) return true;
    }
  }
  return false;
}

/**
 * Walk `root` and return one entry per skill found. The walker stops
 * descending into a directory once it finds a `SKILL.md`. Loose
 * `*.md` files are accepted at any depth; they represent single-file
 * skills.
 */
export function loadSkillsFromDir(opts: LoadSkillsFromDirOptions): SkillLoaderEntry[] {
  const { root, scope } = opts;
  if (!existsSync(root)) return [];
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const ignore = opts.ignoreFiles ?? [
    ...readIgnoreFile(join(root, ".gitignore")),
    ...readIgnoreFile(join(root, ".ignore")),
    ...readIgnoreFile(join(root, ".fdignore")),
  ];

  const maxDepth = opts.maxDepth ?? 6;
  const out: SkillLoaderEntry[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const skillMd = entries.find((e) => e === "SKILL.md");
    if (skillMd) {
      const fullPath = join(dir, skillMd);
      out.push({
        name: dir.split(sep).pop() ?? fullPath,
        path: fullPath,
        content: readFileSync(fullPath, "utf8"),
        scope,
      });
      return; // SKILL.md is a boundary; do not recurse further.
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      const rel = relative(root, fullPath);
      if (shouldIgnore(rel, ignore)) continue;
      if (st.isDirectory()) {
        if (entry.startsWith(".")) continue;
        walk(fullPath, depth + 1);
      } else if (st.isFile() && entry.endsWith(".md")) {
        out.push({
          name: entry.replace(/\.md$/, ""),
          path: fullPath,
          content: readFileSync(fullPath, "utf8"),
          scope,
        });
      }
    }
  };

  walk(root, 0);
  return out;
}

/**
 * Convenience: walk + parse. Returns a list of `ReaperSkill` for
 * every entry that parses cleanly. Entries that fail validation are
 * dropped (callers should log them).
 */
export function loadSkillsFromDirAsRecords(opts: LoadSkillsFromDirOptions): ReaperSkill[] {
  const out: ReaperSkill[] = [];
  for (const entry of loadSkillsFromDir(opts)) {
    const skill = parseSkillFromRaw(entry.content, entry.scope, entry.path);
    if (skill) out.push(skill);
  }
  return out;
}
