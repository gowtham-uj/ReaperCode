/**
 * tools/glob.ts — Phase 4: fast glob tool (no shell invocation).
 *
 * Implements a simple glob-based file finder that supports:
 * - double-star patterns for recursive matching
 * - directory-scoped searches
 * - returns structured results with file count
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const GlobArgsSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.js', '*.md'). Supports ** for recursive matching."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Directory to search in. Defaults to workspace root."),
  })
  .strict();

export type GlobArgs = z.infer<typeof GlobArgsSchema>;

export interface GlobResult {
  files: Array<{ path: string; relativePath: string }>;
  count: number;
}

// ---------------------------------------------------------------------------
// Glob implementation (simple recursive matching)
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a regex.
 * Supports: *, **, ?, character classes
 */
function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match any path segments
        regex += ".*";
        i += 2;
        // Skip trailing slash after **
        if (pattern[i] === "/") i++;
      } else {
        // * — match anything except path separator
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === ".") {
      regex += "\\.";
      i++;
    } else if (char === "/") {
      regex += "/";
      i++;
    } else {
      regex += char;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

async function walkDir(dir: string, baseDir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and .git
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".reaper") continue;
      await walkDir(fullPath, baseDir, results);
    } else {
      results.push(fullPath);
    }
  }
}

/**
 * Find files matching a glob pattern.
 */
export async function executeGlob(
  pattern: string,
  workspaceRoot: string,
  searchPath?: string,
): Promise<GlobResult> {
  const baseDir = searchPath ? join(workspaceRoot, searchPath) : workspaceRoot;
  const regex = globToRegex(pattern);

  const allFiles: string[] = [];
  await walkDir(baseDir, baseDir, allFiles);

  const matches = allFiles
    .map((fullPath) => ({
      path: fullPath,
      relativePath: relative(workspaceRoot, fullPath).replace(/\\/g, "/"),
    }))
    .filter((f) => {
      // Match against relative path
      return regex.test(f.relativePath) || regex.test(f.relativePath.replace(/^\.\//, ""));
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    files: matches,
    count: matches.length,
  };
}
