import * as assert from "node:assert/strict";
import { test } from "node:test";

import { getCompletionSummary, isLowConfidenceCompletion, type CompletionToolCall } from "../../src/runtime/completion-signals.js";
import type { ToolCall } from "../../src/tools/types.js";

function completion(args: CompletionToolCall["args"]): CompletionToolCall {
  return { id: "complete-1", name: "complete_task", args };
}

test("getCompletionSummary returns the first complete_task summary", () => {
  const calls: ToolCall[] = [
    { id: "read-1", name: "read_file", args: { path: "package.json" } } as ToolCall,
    completion({ summary: "done", confidence: "high" }) as ToolCall,
  ];

  assert.equal(getCompletionSummary(calls), "done");
});

test("getCompletionSummary returns undefined when no completion signal exists", () => {
  const calls: ToolCall[] = [{ id: "read-1", name: "read_file", args: { path: "package.json" } } as ToolCall];

  assert.equal(getCompletionSummary(calls), undefined);
});

test("isLowConfidenceCompletion blocks explicit low confidence", () => {
  assert.equal(isLowConfidenceCompletion(completion({ summary: "not sure", confidence: "low" })), true);
});

test("isLowConfidenceCompletion blocks clarifications and known issues", () => {
  assert.equal(isLowConfidenceCompletion(completion({ summary: "needs input", clarification: "which target?" })), true);
  assert.equal(isLowConfidenceCompletion(completion({ summary: "partial", known_issues: ["tests not run"] })), true);
});

test("isLowConfidenceCompletion accepts high-confidence completion without issues", () => {
  assert.equal(isLowConfidenceCompletion(completion({ summary: "verified", confidence: "high" })), false);
});
