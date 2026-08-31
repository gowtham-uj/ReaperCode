/**
 * tools/apply-patch.ts — Phase 3: apply_patch edit mode.
 *
 * Supports unified-diff-style patches that can modify multiple files in one call.
 * Provides parser, matcher, and file applier. Post-write diagnostics are
 * advisory only (never blocks the write).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { normalizeWorkspacePath, PathPolicyError } from "../policy/paths.js";

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
    action: "created" | "modified" | "unchanged" | "error";
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
  // Strip a single trailing newline so the final hunk isn't polluted with a
  // synthetic empty context line; the split below would otherwise emit one.
  let text = patchText;
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);

  const lines = text.split("\n");
  const patches: FilePatch[] = [];
  let currentPatch: FilePatch | null = null;
  let currentHunk: PatchHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");

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

  // Validate that every hunk consumes exactly the line counts declared in its
  // header. A malformed hunk would otherwise shift every subsequent hunk and
  // silently write corrupt output.
  for (const patch of patches) {
    for (const hunk of patch.hunks) {
      const consumedOld = hunk.lines.filter((entry) => entry.type === "context" || entry.type === "remove").length;
      const consumedNew = hunk.lines.filter((entry) => entry.type === "context" || entry.type === "add").length;
      if (consumedOld !== hunk.oldCount) {
        throw new Error(
          `apply_patch: hunk @@ -${hunk.oldStart},${hunk.oldCount} @@ in ${patch.newPath} consumes ${consumedOld} old line(s); malformed hunk.`,
        );
      }
      if (consumedNew !== hunk.newCount) {
        throw new Error(
          `apply_patch: hunk @@ +${hunk.newStart},${hunk.newCount} @@ in ${patch.newPath} consumes ${consumedNew} new line(s); malformed hunk.`,
        );
      }
    }
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

  if (!filePatch.isNew && !fileExists) {
    throw new Error(`Cannot patch non-existent file: ${filePatch.newPath}`);
  }

  const oldLines = oldContent.split("\n");
  const resultLines: string[] = [];
  let currentOldLine = 0;
  let additions = 0;
  let removals = 0;

  for (const hunk of filePatch.hunks) {
    // Anchor to the hunk's declared start line. A start past EOF is a hard
    // failure — it means the patch was generated against different content.
    const targetLine = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    if (targetLine > oldLines.length) {
      throw new Error(
        `apply_patch: hunk starts at line ${hunk.oldStart} but ${filePatch.newPath} only has ${oldLines.length} line(s). Re-read the file and regenerate the patch.`,
      );
    }

    // Copy unchanged lines before this hunk
    while (currentOldLine < targetLine && currentOldLine < oldLines.length) {
      resultLines.push(oldLines[currentOldLine]!);
      currentOldLine++;
    }
    if (currentOldLine < targetLine) {
      throw new Error(`apply_patch: cannot seek hunk to line ${hunk.oldStart} in ${filePatch.newPath}`);
    }

    // Apply hunk with strict matching — any context or removal mismatch is a
    // hard failure, so a stale patch never partially rewrites a file.
    for (const hunkLine of hunk.lines) {
      if (hunkLine.type === "context") {
        if (currentOldLine >= oldLines.length) {
          throw new Error(`apply_patch: context line past end of file in ${filePatch.newPath} (hunk @@ -${hunk.oldStart},${hunk.oldCount} @@)`);
        }
        const actual = oldLines[currentOldLine]!;
        if (hunkLine.content !== actual) {
          throw new Error(
            `apply_patch: context mismatch in ${filePatch.newPath} at line ${currentOldLine + 1}: expected ${JSON.stringify(hunkLine.content)} but found ${JSON.stringify(actual)}. Re-read the file and regenerate the patch.`,
          );
        }
        resultLines.push(actual);
        currentOldLine++;
      } else if (hunkLine.type === "add") {
        resultLines.push(hunkLine.content);
        additions++;
      } else if (hunkLine.type === "remove") {
        if (currentOldLine >= oldLines.length) {
          throw new Error(`apply_patch: removal past end of file in ${filePatch.newPath} (hunk @@ -${hunk.oldStart},${hunk.oldCount} @@)`);
        }
        const actual = oldLines[currentOldLine]!;
        if (hunkLine.content !== actual) {
          throw new Error(
            `apply_patch: removal mismatch in ${filePatch.newPath} at line ${currentOldLine + 1}: expected ${JSON.stringify(hunkLine.content)} but found ${JSON.stringify(actual)}. Re-read the file and regenerate the patch.`,
          );
        }
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
  };
}

function resolvePath(toolPath: string, workspaceRoot: string): string {
  // Every patch path — absolute or relative — is routed through the same
  // workspace-boundary guard used by the other file tools. Absolute paths
  // escaping the root, `..` traversal, and symlinks pointing outside the
  // workspace are all rejected here.
  try {
    return normalizeWorkspacePath(workspaceRoot, toolPath);
  } catch (error) {
    if (error instanceof PathPolicyError) {
      throw new Error(`apply_patch: refusing to write outside the workspace: ${error.message}`);
    }
    throw error;
  }
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
  let allApplied = true;

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
      // Report a real failure instead of silently claiming "unchanged".
      // `applied` is only true when every file in the patch applied.
      allApplied = false;
      fileResults.push({
        path: filePatch.newPath,
        action: "error",
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
    applied: allApplied && !dryRun,
    dry_run: dryRun,
  };
}
