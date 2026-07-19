/**
 * tools/apply-patch.ts — Phase 3: apply_patch edit mode.
 *
 * Supports unified-diff-style patches that can modify multiple files in one call.
 * Provides parser, matcher, and file applier. Post-write diagnostics are
 * advisory only (never blocks the write).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ApplyPatchArgsSchema = z
  .object({
    patch: z
      .string()
      .min(1)
      .describe(
        "Unified diff patch text. Supports multiple file headers (--- a/path / +++ b/path). " +
          "Context lines start with space, removals with -, additions with +. " +
          "Hunk headers: @@ -start,count +start,count @@",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe("If true, return what would change without writing to disk."),
  })
  .strict();

export type ApplyPatchArgs = z.infer<typeof ApplyPatchArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ type: "context" | "add" | "remove"; content: string }>;
}

export interface FilePatch {
  oldPath: string | null;
  newPath: string;
  isNew: boolean;
  hunks: PatchHunk[];
}

export interface ApplyPatchResult {
  files: Array<{
    path: string;
    action: "created" | "modified" | "unchanged";
    additions: number;
    removals: number;
    diagnostics: string[];
  }>;
  totalAdditions: number;
  totalRemovals: number;
  applied: boolean;
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff patch into structured FilePatch objects.
 *
 * Supports:
 * - Multiple files in one patch (separated by --- / +++ headers)
 * - Standard @@ hunk headers
 * - New file creation (--- /dev/null)
 * - Context lines, removals, additions
 */
export function parsePatch(patchText: string): FilePatch[] {
  const lines = patchText.split("\n");
  const patches: FilePatch[] = [];
  let currentPatch: FilePatch | null = null;
  let currentHunk: PatchHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // File header
    if (line.startsWith("--- ")) {
      // Flush previous hunk/patch
      if (currentHunk && currentPatch) {
        currentPatch.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentPatch) {
        patches.push(currentPatch);
      }

      const oldPath = line.slice(4).trim();
      // Strip a/ prefix if present
      const cleanOldPath = oldPath.replace(/^a\//, "");

      // Next line should be +++ b/path or +++ /dev/null
      i++;
      const nextLine = lines[i] ?? "";
      if (!nextLine.startsWith("+++ ")) {
        throw new Error(`Expected +++ header after --- at line ${i}, got: ${nextLine}`);
      }
      const newPath = nextLine.slice(4).trim().replace(/^b\//, "");
      const isNew = cleanOldPath === "/dev/null" || cleanOldPath === "";

      currentPatch = {
        oldPath: isNew ? null : cleanOldPath,
        newPath,
        isNew,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      // Flush previous hunk
      if (currentHunk && currentPatch) {
        currentPatch.hunks.push(currentHunk);
      }

      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        throw new Error(`Invalid hunk header at line ${i + 1}: ${line}`);
      }

      currentHunk = {
        oldStart: parseInt(match[1]!, 10),
        oldCount: match[2] ? parseInt(match[2], 10) : 1,
        newStart: match[3] ? parseInt(match[3], 10) : 1,
        newCount: match[4] ? parseInt(match[4], 10) : 1,
        lines: [],
      };
      continue;
    }

    // Hunk content
    if (currentHunk) {
      if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : "" });
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith("\\")) {
        // No newline at end of file marker — skip
        continue;
      } else if (line.trim() === "") {
        // Empty line in hunk — treat as context
        currentHunk.lines.push({ type: "context", content: "" });
      }
    }
  }

  // Flush trailing hunk/patch
  if (currentHunk && currentPatch) {
    currentPatch.hunks.push(currentHunk);
  }
  if (currentPatch) {
    patches.push(currentPatch);
  }

  return patches;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/**
 * Apply a single FilePatch to the file system.
 * Returns the new content, additions, and removals.
 */
async function applyFilePatch(
  filePatch: FilePatch,
  workspaceRoot: string,
  dryRun: boolean,
): Promise<{ path: string; action: "created" | "modified" | "unchanged"; additions: number; removals: number; newContent: string }> {
  const fullPath = resolvePath(filePatch.newPath, workspaceRoot);

  // Read existing content (or empty if new file)
  let oldContent = "";
  let fileExists = false;
  try {
    oldContent = await readFile(fullPath, "utf8");
    fileExists = true;
  } catch {
    // File doesn't exist yet
  }

  if (filePatch.isNew && fileExists) {
    // File already exists but patch says new — merge by replacing
  }

  if (!filePatch.isNew && !fileExists) {
    throw new Error(`Cannot patch non-existent file: ${filePatch.newPath}`);
  }

  const oldLines = oldContent.split("\n");
  let resultLines: string[] = [];
  let currentOldLine = 0;
  let additions = 0;
  let removals = 0;

  // Tolerate at most this many context-line mismatches before treating the
  // hunk as not applied. Without a ceiling, a single stray space in the
  // patch silently corrupts the file because the runner silently keeps
  // the expected line instead of the supplied context.
  const CONTEXT_MISMATCH_LIMIT = 4;
  let contextMismatches = 0;
  const mismatchedLines: number[] = [];

  for (const hunk of filePatch.hunks) {
    // Copy unchanged lines before this hunk
    const oldStartIndex = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    while (currentOldLine < oldStartIndex && currentOldLine < oldLines.length) {
      resultLines.push(oldLines[currentOldLine]!);
      currentOldLine++;
    }

    // Apply hunk
    for (const hunkLine of hunk.lines) {
      if (hunkLine.type === "context") {
        const expected = oldLines[currentOldLine] ?? "";
        if (hunkLine.content !== expected) {
          contextMismatches += 1;
          if (mismatchedLines.length < CONTEXT_MISMATCH_LIMIT) {
            mismatchedLines.push(currentOldLine + 1);
          }
        }
        resultLines.push(expected);
        currentOldLine++;
      } else if (hunkLine.type === "add") {
        resultLines.push(hunkLine.content);
        additions++;
      } else if (hunkLine.type === "remove") {
        // Skip the old line (removal)
        currentOldLine++;
        removals++;
      }
    }
  }

  // Copy remaining unchanged lines after last hunk
  while (currentOldLine < oldLines.length) {
    resultLines.push(oldLines[currentOldLine]!);
    currentOldLine++;
  }

  const newContent = resultLines.join("\n");
  const action = filePatch.isNew ? "created" : (newContent === oldContent ? "unchanged" : "modified");

  if (contextMismatches > CONTEXT_MISMATCH_LIMIT) {
    // The patch does not actually match the source. Refuse to write —
    // otherwise we silently drop the model's intended content into the
    // file and the only signal is "the file changed but doesn't compile".
    throw new Error(
      `apply_patch: ${contextMismatches} context-line mismatches in ${filePatch.newPath} (lines ${mismatchedLines.join(", ")}…) — patch does not match the source file. Re-read the file and regenerate the patch.`,
    );
  }

  if (!dryRun && action !== "unchanged") {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, newContent, "utf8");
  }

  return {
    path: filePatch.newPath,
    action,
    additions,
    removals,
    newContent,
    ...(contextMismatches > 0
      ? {
          diagnostics: {
            contextMismatches,
            mismatchedLines,
            warning: `${contextMismatches} context-line mismatch(es) in ${filePatch.newPath}; the surrounding file content was preserved.`,
          },
        }
      : {}),
  };
}

function resolvePath(toolPath: string, workspaceRoot: string): string {
  if (toolPath.startsWith("/")) {
    // Absolute path — within workspace root
    return toolPath;
  }
  return `${workspaceRoot}/${toolPath}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff patch to files in the workspace.
 *
 * @param patchText - The unified diff patch text
 * @param workspaceRoot - Root directory for resolving relative paths
 * @param dryRun - If true, don't write to disk
 * @returns Structured result with per-file stats
 */
export async function executeApplyPatch(
  patchText: string,
  workspaceRoot: string,
  dryRun: boolean = false,
): Promise<ApplyPatchResult> {
  const patches = parsePatch(patchText);

  if (patches.length === 0) {
    throw new Error("No valid file patches found in the patch text");
  }

  const fileResults: ApplyPatchResult["files"] = [];
  let totalAdditions = 0;
  let totalRemovals = 0;

  for (const filePatch of patches) {
    try {
      const result = await applyFilePatch(filePatch, workspaceRoot, dryRun);
      fileResults.push({
        path: result.path,
        action: result.action,
        additions: result.additions,
        removals: result.removals,
        diagnostics: [],
      });
      totalAdditions += result.additions;
      totalRemovals += result.removals;
    } catch (error) {
      fileResults.push({
        path: filePatch.newPath,
        action: "unchanged",
        additions: 0,
        removals: 0,
        diagnostics: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return {
    files: fileResults,
    totalAdditions,
    totalRemovals,
    applied: !dryRun,
    dry_run: dryRun,
  };
}
