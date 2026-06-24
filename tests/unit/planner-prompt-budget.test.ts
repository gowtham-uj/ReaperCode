import test from "node:test";
import assert from "node:assert/strict";

import { buildPlannerSubagentPrompt, selectPlannerContextChunks, selectPlannerToolResults, plannerChunkBudget } from "../../src/runtime/prompt-builders.js";
import type { ContentPrepResult } from "../../src/runtime/content-prep.js";
import type { EnvironmentFingerprint } from "../../src/runtime/fingerprint.js";
import type { ToolResult } from "../../src/tools/types.js";

test("planner prompt budget is bounded to fit MiniMax low-latency window", () => {
  const contentPrep = makeContentPrep();
  const toolResults = makeToolResults();
  const hugeFeedback = "x".repeat(8000);
  const prompt = buildPlannerSubagentPrompt({
    prompt: "Build a minimal todo API",
    contentPrep,
    toolResults,
    iteration: 0,
    feedback: [hugeFeedback, hugeFeedback, hugeFeedback],
    negativeConstraints: [],
  });
  assert.ok(prompt.length < 60000, `planner prompt should be <60k chars, got ${prompt.length}`);
  assert.ok(prompt.length > 1000, `planner prompt should still be substantive, got ${prompt.length}`);
});

test("planner prompt caps per-feedback entry to keep replan latency bounded", () => {
  const contentPrep = makeContentPrep();
  const hugeFeedback = "y".repeat(8000);
  const prompt = buildPlannerSubagentPrompt({
    prompt: "Repair the failing build",
    contentPrep,
    toolResults: makeToolResults(),
    iteration: 1,
    feedback: [hugeFeedback, hugeFeedback, hugeFeedback],
    negativeConstraints: [],
  });
  // total should be substantially smaller than unbounded (3 * 8000 = 24000 just from feedback)
  const feedbackBlock = prompt.split("Verification feedback to fix:")[1] ?? "";
  assert.ok(feedbackBlock.length < 4000, `feedback section should be capped, got ${feedbackBlock.length}`);
});

test("planner chunk budgets and chunk selection stay compact", () => {
  assert.equal(plannerChunkBudget("package.json"), 1200);
  assert.equal(plannerChunkBudget("README.md"), 700);
  const chunks = makeContentPrep().preparedContext.chunks;
  const selected = selectPlannerContextChunks(makeContentPrep());
  assert.ok(selected.length <= 4, `expected <=4 chunks, got ${selected.length}`);
});

test("planner tool-result selector caps history", () => {
  const trs = Array.from({ length: 12 }, (_, i) => ({ ok: i % 2 === 0, toolCallId: `t${i}`, name: "run_shell_command", args: { cmd: `echo ${i}` }, durationMs: 1 }) as unknown as ToolResult);
  const selected = selectPlannerToolResults(trs);
  assert.ok(selected.length <= 5, `expected <=5 tool results in planner prompt, got ${selected.length}`);
});

function makeContentPrep(): ContentPrepResult {
  const chunks = [
    { path: "package.json", content: "a".repeat(2000), tokenEstimate: 500, kind: "config" },
    { path: "tsconfig.json", content: "b".repeat(1500), tokenEstimate: 380, kind: "config" },
    { path: "README.md", content: "c".repeat(1200), tokenEstimate: 300, kind: "doc" },
    { path: "src/index.ts", content: "d".repeat(900), tokenEstimate: 230, kind: "source" },
    { path: "src/util.ts", content: "e".repeat(800), tokenEstimate: 200, kind: "source" },
    { path: "tests/index.test.ts", content: "f".repeat(700), tokenEstimate: 180, kind: "test" },
    { path: "public/index.html", content: "g".repeat(600), tokenEstimate: 150, kind: "asset" },
  ];
  const fingerprint: EnvironmentFingerprint = {
    os: "linux",
    arch: "x64",
    nodeVersion: "v20.20.2",
    npmVersion: "10.8.2",
    glibcVersion: "2.39",
    cwd: "/tmp/test",
    dockerStatus: "available",
    availableTools: ["git", "curl"],
    dockerCliAvailable: true,
    dockerDaemonAvailable: true,
  };
  return {
    index: {
      runId: "test",
      sessionId: "test",
      traceId: "test",
      workspaceRoot: "/tmp/test",
      totalBytes: 1000,
      totalTokens: 2000,
      files: [],
    } as unknown as ContentPrepResult["index"],
    environmentFingerprint: fingerprint,
    preparedContext: {
      chunks: chunks as unknown as ContentPrepResult["preparedContext"]["chunks"],
      fileTree: ["package.json", "tsconfig.json", "README.md", "src/index.ts", "src/util.ts", "tests/index.test.ts", "public/index.html"],
      totalTokens: 2000,
    },
    compactedHistory: { compacted: [], dropped: [] },
    budget: { windowTokens: 8000, usedTokens: 0, remainingTokens: 8000 },
  } as unknown as ContentPrepResult;
}

function makeToolResults(): ToolResult[] {
  return Array.from({ length: 6 }, (_, i) => ({ ok: i % 2 === 0, toolCallId: `t${i}`, name: "run_shell_command", args: { cmd: `echo ${i}` }, durationMs: 1 }) as unknown as ToolResult);
}
