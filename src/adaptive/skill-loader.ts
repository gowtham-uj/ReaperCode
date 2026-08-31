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

const globCache = new Map<string, RegExp>();

/**
 * Compile a gitignore-style pattern into a regex matched against a
 * single path segment or a full relative path.
 *
 * `*` matches within one segment, `**` matches across segments, `?`
 * matches one non-separator character. Previously patterns were compared
 * literally, so the extremely common `*.tmp` / `build-*` forms in a
 * `.gitignore` never matched anything and the ignore file was
 * effectively inert.
 */
function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

function shouldIgnore(rel: string, patterns: string[]): boolean {
  // Normalize to POSIX separators so patterns behave the same on Windows.
  const posixRel = rel.split(sep).join("/");
  const basename = posixRel.split("/").pop() ?? posixRel;
  for (const raw of patterns) {
    if (!raw) continue;
    const negated = raw.startsWith("!");
    if (negated) continue; // Negations are not supported; ignoring them is the safe direction.
    const dirOnly = raw.endsWith("/");
    const pattern = (dirOnly ? raw.slice(0, -1) : raw).replace(/^\.\//, "");
    if (!pattern) continue;

    const re = globToRegExp(pattern);
    // Anchored pattern (contains a slash): match the full relative path.
    if (pattern.includes("/")) {
      if (re.test(posixRel) || posixRel.startsWith(`${pattern}/`)) return true;
      continue;
    }
    // Unanchored: match any path segment, gitignore-style.
    if (re.test(basename)) return true;
    if (posixRel.split("/").some((segment) => re.test(segment))) return true;
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
  // Explicit patterns from the caller are authoritative — do not augment
  // them with on-disk ignore files.
  const collectNested = opts.ignoreFiles === undefined;

  const walk = (dir: string, depth: number, inherited: string[]) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Ignore files apply to their own directory and everything below it.
    // Reading only the root's meant a nested `.gitignore` was silently
    // ignored and its excluded files were loaded as skills.
    const ignore = collectNested && depth > 0
      ? [
          ...inherited,
          ...readIgnoreFile(join(dir, ".gitignore")),
          ...readIgnoreFile(join(dir, ".ignore")),
          ...readIgnoreFile(join(dir, ".fdignore")),
        ]
      : inherited;
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
        walk(fullPath, depth + 1, ignore);
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

  walk(root, 0, ignore);
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
