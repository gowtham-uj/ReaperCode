import { buildPlannerSubagentPrompt, buildPatcherSubagentPrompt } from "../src/runtime/prompt-builders.js";
import type { ContentPrepResult, ToolResult } from "../src/runtime/content-prep.js";
import type { EnvironmentFingerprint } from "../src/runtime/fingerprint.js";

const env: EnvironmentFingerprint = {
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

const cp: ContentPrepResult = {
  index: { runId: "x", sessionId: "x", traceId: "x", workspaceRoot: "/tmp/test", totalBytes: 0, totalTokens: 0, files: [] } as unknown as ContentPrepResult["index"],
  environmentFingerprint: env,
  preparedContext: {
    chunks: [
      { path: "package.json", content: JSON.stringify({ name: "x", scripts: { build: "tsc", test: "vitest" } }), tokenEstimate: 50, kind: "config" },
      { path: "tsconfig.json", content: "{\"compilerOptions\":{\"strict\":true}}", tokenEstimate: 30, kind: "config" },
      { path: "src/index.ts", content: "export const x = 1;\n".repeat(200), tokenEstimate: 100, kind: "source" },
      { path: "README.md", content: "# Test\n".repeat(100), tokenEstimate: 50, kind: "doc" },
    ] as unknown as ContentPrepResult["preparedContext"]["chunks"],
    fileTree: ["package.json", "tsconfig.json", "src/index.ts", "README.md"],
    totalTokens: 230,
  },
  compactedHistory: { compacted: [], dropped: [] },
  budget: { windowTokens: 8000, usedTokens: 0, remainingTokens: 8000 },
} as unknown as ContentPrepResult;

const trs: ToolResult[] = Array.from({ length: 5 }, (_, i) => ({
  ok: i % 2 === 0,
  toolCallId: `t${i}`,
  name: "bash",
  args: { cmd: `echo ${i}` },
  durationMs: 1,
  output: "ok",
}) as unknown as ToolResult);

const planner = buildPlannerSubagentPrompt({
  prompt: "Build a minimal todo API",
  contentPrep: cp,
  toolResults: trs,
  iteration: 0,
  feedback: [],
  negativeConstraints: [],
});
console.log("PLANNER prompt length:", planner.length);
console.log("PLANNER lines around Recent Tool Results:", planner.split("# Recent Tool results").length);

const patcher = buildPatcherSubagentPrompt({
  prompt: "Repair build failure",
  contentPrep: cp,
  currentStep: undefined,
  isFinalPlanStep: false,
  toolResults: trs,
  feedback: ["x".repeat(8000), "y".repeat(8000)],
  negativeConstraints: [],
  patchRequest: {
    taskId: "x",
    reasonPatchNeeded: "z".repeat(8000),
    failureContext: { errorLogs: "e".repeat(8000), observedBehavior: "o".repeat(8000) },
    hypothesisLedger: {
      problemStatement: "p".repeat(8000),
      hypotheses: [
        { id: "H1", cause: "c".repeat(8000), evidence: Array.from({ length: 8 }, () => "v".repeat(8000)) },
      ],
    },
    scope: { filesHint: ["a", "b"] },
    constraints: { styleGuide: "s".repeat(8000) },
  },
  runId: "r",
  hypothesisRescueEnabled: true,
});
console.log("PATCHER prompt length:", patcher.length);
const sections = planner.split(/^# /m).slice(1);
for (const s of sections) {
  const firstLine = s.split("\n", 1)[0];
  console.log(`  PLANNER.${firstLine} -> ${s.length}`);
}
