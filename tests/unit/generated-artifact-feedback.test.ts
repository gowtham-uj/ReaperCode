import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasRecentIncompleteGeneratedArtifact,
  hasRecentStructuredResponseFallbackFeedback,
} from "../../src/runtime/generated-artifact-feedback.js";
import type { ToolResult } from "../../src/tools/types.js";

test("hasRecentStructuredResponseFallbackFeedback detects recent truncated structured response feedback", () => {
  assert.equal(
    hasRecentStructuredResponseFallbackFeedback([
      "old feedback",
      "model response was truncated or invalid; retry with compact output",
    ]),
    true,
  );
});

test("hasRecentStructuredResponseFallbackFeedback only checks the recent feedback window", () => {
  assert.equal(
    hasRecentStructuredResponseFallbackFeedback([
      "model response was truncated or invalid",
      "one",
      "two",
      "three",
      "four",
    ]),
    false,
  );
});

test("hasRecentIncompleteGeneratedArtifact detects incomplete source writes", () => {
  const results: ToolResult[] = [
    { toolCallId: "write-1", name: "write_file", ok: false, durationMs: 1, args: {}, error: { code: "incomplete_source_write", message: "truncated" } } as ToolResult,
  ];

  assert.equal(hasRecentIncompleteGeneratedArtifact(results), true);
});

test("hasRecentIncompleteGeneratedArtifact detects incomplete-source message patterns", () => {
  const results: ToolResult[] = [
    { toolCallId: "write-1", name: "write_file", ok: false, durationMs: 1, args: {}, error: { code: "other", message: "appears truncated or syntactically incomplete" } } as ToolResult,
  ];

  assert.equal(hasRecentIncompleteGeneratedArtifact(results), true);
});

test("hasRecentIncompleteGeneratedArtifact ignores successful and stale failures", () => {
  const stale = { toolCallId: "write-old", name: "write_file", ok: false, durationMs: 1, args: {}, error: { code: "incomplete_source_write", message: "old" } } as ToolResult;
  const recentSuccess = { toolCallId: "write-ok", name: "write_file", ok: true, durationMs: 1, args: {}, output: {} } as ToolResult;
  const recent = Array.from({ length: 10 }, (_, index) => ({ ...recentSuccess, toolCallId: `ok-${index}` } as ToolResult));

  assert.equal(hasRecentIncompleteGeneratedArtifact([stale, ...recent]), false);
});
