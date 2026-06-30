import type { ToolResult } from "../tools/types.js";

export function hasRecentStructuredResponseFallbackFeedback(feedback: string[]): boolean {
  return feedback.slice(-4).some((entry) => /truncated\/invalid structured model response|model response was truncated or invalid/i.test(entry));
}

export function hasRecentIncompleteGeneratedArtifact(results: ToolResult[]): boolean {
  return results.slice(-10).some((result) => {
    if (result.ok) return false;
    return (
      result.error?.code === "incomplete_source_write" ||
      /appears truncated or syntactically incomplete|partial full-file writes/i.test(result.error?.message ?? "")
    );
  });
}
