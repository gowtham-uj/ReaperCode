/**
 * Phase T3.11 — file-hints extraction from engine.ts (Wave 1, first move).
 *
 * Pure helpers for inferring the file paths a tool result is "about".
 * Used by rescue diagnostics, completion-gate feedback, and replan
 * prompts to surface where the agent should look next. All functions
 * are pure: no engine state, no I/O.
 *
 * Extracted from engine.ts because:
 *   1. They're a coherent cluster (every helper feeds the next).
 *   2. They have no engine-state coupling — easy to test in isolation.
 *   3. The rescue-watchdog Wave 1b/c extractions depend on these
 *      helpers being in a stable location; pulling them out first
 *      unblocks the rest of Wave 1.
 *
 * Nothing in this module imports from engine.ts. Anything engine.ts
 * needs from here is imported explicitly.
 */

import type { ToolResult } from "../tools/types.js";

/**
 * Normalize a path so two surface forms of the same artifact compare
 * equal. Replaces backslashes with forward slashes, strips leading
 * `./` and trailing whitespace.
 *
 * Examples:
 *   "src/foo.c:12:34" → "src/foo.c"  (matches what extractFilePathsFromFailure does)
 *   "  src/bar.py  " → "src/bar.py"
 *   "src/baz.ts"      → "src/baz.ts"
 */
export function normalizeArtifactPathForMatch(artifact: string): string {
  return artifact.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

/**
 * Strip workspace-root prefixes from an artifact path. Used to
 * dedupe paths surfaced from compiler output that may include the
 * absolute workspace root under several Reaper sandbox layouts:
 *
 *   - `/app/...` — Reaper eval sandbox container path
 *   - `/workspaces/<task>/workspace/...` — tb-eval layout
 *   - `/reaper_eval/workspaces/<task>/workspace/...` — Reaper's own eval
 *   - `/<root>/workspace/...` — generic prefix (last-resort)
 *
 * The function returns the workspace-relative path; if no known
 * prefix matches, the input is returned unchanged.
 */
export function stripWorkspacePrefix(artifact: string): string {
  if (artifact.startsWith("/app/")) return artifact.slice("/app/".length);
  const marker = "/workspaces/";
  const markerIndex = artifact.indexOf(marker);
  if (markerIndex >= 0) {
    const parts = artifact.slice(markerIndex + marker.length).split("/");
    return parts.slice(2).join("/");
  }
  const evalMarker = "/reaper_eval/workspaces/";
  const evalIndex = artifact.indexOf(evalMarker);
  if (evalIndex >= 0) {
    const parts = artifact.slice(evalIndex + evalMarker.length).split("/");
    return parts.slice(2).join("/");
  }
  return artifact.replace(/^.*\/workspace\//, "");
}

/**
 * Dedupe strings, drop empties, trim. Stable order preserved by Set
 * iteration semantics in modern V8.
 */
export function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim()).map((item) => item.trim()))];
}

/**
 * Detect paths the agent should NOT investigate — generated files,
 * vendored deps, build outputs, scratch state.
 *
 * Used by `inferFilesHintFromResults` to keep the diagnostic
 * `filesHint` field focused on source files the agent can actually
 * edit.
 */
export function isGeneratedOrBuildPath(filePath: string): boolean {
  return /(^|\/)(node_modules|\.git|scratchpad|\.reaper|dist|build|coverage|\.next|\.cache|CMakeFiles|__pycache__|target)(\/|$)/.test(
    filePath.replace(/\\/g, "/"),
  );
}

/**
 * Extract file paths mentioned in a tool result's error message
 * and args. Used by the rescue diagnostic pipeline to suggest
 * candidate files for the patcher subagent.
 *
 * The extraction is intentionally aggressive — false positives
 * are filtered downstream by `isGeneratedOrBuildPath`.
 */
export function extractFilePathsFromFailure(result: ToolResult): string[] {
  const message = result.error?.message ?? "";
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const paths = typeof args.path === "string" ? [args.path] : [];
  const primaryDiagnosticPaths: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (/^\s*In file included from\b/i.test(line)) continue;
    if (!/(?:fatal error|error:|undefined reference|cannot find|no such file|not found|ENOENT|does not name a type|was not declared|expected)/i.test(line)) continue;
    for (const match of line.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]+)(?::\d+:\d+)?/g)) {
      if (match[1]) primaryDiagnosticPaths.push(match[1]);
    }
  }
  const patterns = [
    /(?:\s|^)([A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]+):\d+:\d+/g,
    /(?:from|open|access|file) ['"]([^'"]+)['"]/gi,
    /([A-Za-z0-9_./-]+\/[A-Za-z0-9_.+-]+\.[A-Za-z0-9_+-]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return uniqueStrings([
    ...primaryDiagnosticPaths,
    ...paths,
  ].map((item) => stripWorkspacePrefix(normalizeArtifactPathForMatch(item))));
}

/**
 * Infer a `filesHint` array for a tool-result batch — the files the
 * agent should look at next. Filters out generated / build paths and
 * deduplicates. Capped at 10 entries.
 *
 * `args.path` / `args.sourcePath` / `args.targetPath` / `args.file` /
 * `args.filePath` are also extracted (covers the case where a tool
 * succeeded but the next step needs the target file).
 */
export function inferFilesHintFromResults(results: ToolResult[]): string[] {
  const files = new Set<string>();
  for (const result of results) {
    for (const file of extractFilePathsFromFailure(result)) {
      if (!isGeneratedOrBuildPath(file)) files.add(file);
    }
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    for (const key of ["path", "sourcePath", "targetPath", "file", "filePath"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim() && !isGeneratedOrBuildPath(value)) files.add(value);
    }
  }
  return [...files].slice(0, 10);
}
