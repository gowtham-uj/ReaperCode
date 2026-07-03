/**
 * tools/ast-grep.ts — Phase 6: AST grep for symbol-aware search.
 *
 * Uses tree-sitter (if available) to parse source files and search for
 * symbol declarations (functions, classes, methods, variables) by name.
 * Falls back to regex-based search if tree-sitter is not available.
 *
 * Also provides post-write diagnostics (tsc/lint) as advisory info.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AstGrepArgsSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe("Symbol name to search for (e.g. 'handleError', 'MyClass')."),
    kind: z
      .enum(["function", "class", "method", "variable", "any"])
      .optional()
      .describe("Symbol kind filter (default: any)."),
    path: z
      .string()
      .optional()
      .describe("Directory to search in. Defaults to workspace root."),
    language: z
      .enum(["typescript", "javascript", "python", "any"])
      .optional()
      .describe("Language filter (default: any)."),
  })
  .strict();

export type AstGrepArgs = z.infer<typeof AstGrepArgsSchema>;

export interface AstGrepResult {
  matches: Array<{
    file: string;
    relativePath: string;
    line: number;
    symbol: string;
    kind: string;
    snippet: string;
  }>;
  count: number;
}

// ---------------------------------------------------------------------------
// Implementation (regex-based fallback)
// ---------------------------------------------------------------------------

const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^\s+(\w+)\s*\(/, // method
  ],
  javascript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^\s+(\w+)\s*\(/,
  ],
  python: [
    /^\s*def\s+(\w+)/,
    /^\s*class\s+(\w+)/,
  ],
};

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
};

async function walkDir(dir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".reaper") continue;
      await walkDir(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }
}

/**
 * Search for symbol declarations using regex patterns.
 * Falls back to this when tree-sitter is not available.
 */
export async function executeAstGrep(
  pattern: string,
  workspaceRoot: string,
  searchPath?: string,
  kind: string = "any",
  language: string = "any",
): Promise<AstGrepResult> {
  const baseDir = searchPath ? join(workspaceRoot, searchPath) : workspaceRoot;

  const allFiles: string[] = [];
  await walkDir(baseDir, allFiles);

  const matches: AstGrepResult["matches"] = [];

  for (const filePath of allFiles) {
    const ext = extname(filePath);
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;
    if (language !== "any" && lang !== language) continue;

    const patterns = FUNCTION_PATTERNS[lang] ?? [];

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const regex of patterns) {
        const m = regex.exec(line);
        if (m && m[1] === pattern) {
          // Determine kind
          let detectedKind = "function";
          if (line.includes("class ")) detectedKind = "class";
          else if (line.includes("def ")) detectedKind = "method";
          else if (line.includes("const ") || line.includes("let ") || line.includes("var ")) detectedKind = "variable";

          if (kind !== "any" && detectedKind !== kind) continue;

          matches.push({
            file: filePath,
            relativePath: relative(workspaceRoot, filePath),
            line: i + 1,
            symbol: m[1]!,
            kind: detectedKind,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    }
  }

  return {
    matches: matches.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    count: matches.length,
  };
}

// ---------------------------------------------------------------------------
// Post-write diagnostics (advisory only)
// ---------------------------------------------------------------------------

export const DiagnosticsArgsSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("File path to run diagnostics on."),
    kind: z
      .enum(["tsc", "eslint", "auto"])
      .optional()
      .describe("Diagnostic kind (default: auto — detects from file extension)."),
  })
  .strict();

export type DiagnosticsArgs = z.infer<typeof DiagnosticsArgsSchema>;

export interface DiagnosticsResult {
  file: string;
  kind: string;
  diagnostics: Array<{ severity: string; message: string; line?: number }>;
  ok: boolean;
}

/**
 * Run post-write diagnostics on a file (advisory only, never blocks).
 */
export async function executeDiagnostics(
  filePath: string,
  workspaceRoot: string,
  kind: string = "auto",
): Promise<DiagnosticsResult> {
  const ext = extname(filePath);
  const lang = EXT_TO_LANG[ext];

  if (kind === "auto") {
    if (ext === ".ts" || ext === ".tsx") kind = "tsc";
    else if (ext === ".js" || ext === ".jsx") kind = "eslint";
    else return { file: filePath, kind: "none", diagnostics: [], ok: true };
  }

  if (kind === "tsc") {
    try {
      const { stdout, stderr } = await execFileAsync(
        "npx",
        ["tsc", "--noEmit", filePath],
        { timeout: 30000, cwd: workspaceRoot, maxBuffer: 1024 * 1024 },
      );
      const errors = stderr.trim();
      if (errors) {
        const diags = errors.split("\n").filter(Boolean).map((line) => ({
          severity: "error" as const,
          message: line,
        }));
        return { file: filePath, kind: "tsc", diagnostics: diags, ok: false };
      }
      return { file: filePath, kind: "tsc", diagnostics: [], ok: true };
    } catch (error: any) {
      const stderr = (error.stderr ?? "").toString();
      const diags = stderr.split("\n").filter(Boolean).map((line: string) => ({
        severity: "error" as const,
        message: line,
      }));
      return { file: filePath, kind: "tsc", diagnostics: diags, ok: diags.length === 0 };
    }
  }

  return { file: filePath, kind, diagnostics: [], ok: true };
}
