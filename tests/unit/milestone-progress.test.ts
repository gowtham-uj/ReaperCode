import test from "node:test";
import assert from "node:assert/strict";

import { evaluateMilestoneProgress, getAtomicExecutionFeedback } from "../../src/runtime/milestone-progress.js";
import type { ToolResult } from "../../src/tools/types.js";

test("different failed commands at the same unresolved milestone force escalation", () => {
  const decision = evaluateMilestoneProgress([
    successfulShell("build", "cmake --build build", "[100%] Built target converter"),
    failedShell("run-a", "./build/converter fixtures/a.dat out/a.json", "cannot open input"),
    successfulWrite("edit", "src/converter.cpp"),
    failedShell("run-b", "./build/converter fixtures out", "Segmentation fault (core dumped)"),
  ]);

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.milestone, "build_passed");
  assert.match(decision.reason ?? "", /runtime crash|verified milestone/i);
});

test("source edits do not hide repeated high-signal failures", () => {
  const decision = evaluateMilestoneProgress([
    failedShell("build-a", "npm run build", "error TS2322"),
    successfulWrite("edit-a", "src/a.ts"),
    failedShell("build-b", "npx tsc --noEmit", "error TS2322"),
  ]);

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.failuresSinceMilestone, 2);
  assert.match(decision.reason ?? "", /2 build\/runtime\/verification failures/i);
});

test("blocked discriminating diagnostic immediately promotes simple execution", () => {
  const result = failedShell("probe", "printf 'probe' > .reaper/tmp/probe.c", "blocked");
  result.error = { code: "policy_block", message: "Use write_file for source probes." };

  const decision = evaluateMilestoneProgress([result]);

  assert.equal(decision.shouldEscalate, true);
  assert.match(decision.reason ?? "", /diagnostic|required execution action was blocked/i);
});

test("read-only investigation cannot consume the implementation checkpoint", () => {
  const results = Array.from({ length: 10 }, (_, index) => readResult(`read-${index}`, `src/${index}.ts`));

  const decision = evaluateMilestoneProgress(results);

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.readOnlySinceMilestone, 10);
});

test("a strict verification milestone clears earlier failures", () => {
  const decision = evaluateMilestoneProgress([
    failedShell("build-a", "npm run build", "compile failed"),
    successfulWrite("edit", "src/a.ts"),
    successfulShell("verify", "npm test", "10 passed"),
  ]);

  assert.equal(decision.shouldEscalate, false);
  assert.equal(decision.milestone, "verification_passed");
  assert.equal(decision.failuresSinceMilestone, 0);
});

test("successful build feedback exposes targets and requires atomic execution stages", () => {
  const feedback = getAtomicExecutionFeedback([
    successfulShell("build", "cmake --build build", "[100%] Linking CXX executable mdf_converter\n[100%] Built target mdf_converter"),
  ]);

  assert.match(feedback ?? "", /Build milestone passed/);
  assert.match(feedback ?? "", /mdf_converter/);
  assert.match(feedback ?? "", /separately/);
});

test("hidden nonzero stage status is not counted as a successful milestone", () => {
  const decision = evaluateMilestoneProgress([
    successfulShell("masked", "cmake --build build; echo BUILD=$?; echo done", "BUILD=2\ndone"),
    failedShell("runtime", "./build/converter input output", "Segmentation fault"),
  ]);

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.milestone, "none");
  assert.equal(decision.failuresSinceMilestone, 2);
});

function successfulWrite(id: string, filePath: string): ToolResult {
  return {
    toolCallId: id,
    name: "write_file",
    ok: true,
    durationMs: 1,
    args: { path: filePath, content: "changed" },
    output: { path: filePath },
  };
}

function readResult(id: string, filePath: string): ToolResult {
  return {
    toolCallId: id,
    name: "read_file",
    ok: true,
    durationMs: 1,
    args: { path: filePath },
    output: { path: filePath, content: "" },
  };
}

function successfulShell(id: string, cmd: string, stdout: string): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok: true,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 0, stdout, stderr: "" },
  };
}

function failedShell(id: string, cmd: string, message: string): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok: false,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 1, stdout: "", stderr: message },
    error: { code: "tool_error", message },
  };
}
