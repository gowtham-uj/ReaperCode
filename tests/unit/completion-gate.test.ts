import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  validateCompletionSignal,
  renderCompletionGateRejectionFeedback,
  runCompletionVerification,
  COMPLETION_GATE_MIN_SUMMARY_CHARS,
} from "../../src/runtime/completion-gate.js";
import type { ToolCall } from "../../src/tools/types.js";

function completeTask(overrides: Partial<{ id: string; summary: string; args: Record<string, unknown> }> = {}): ToolCall {
  return {
    id: overrides.id ?? "complete-1",
    name: "complete_task",
    args: {
      summary: overrides.summary ?? "Task is fully done; the requested artifact was created and verified by a passing build + test command.",
      ...(overrides.args ?? {}),
    },
  };
}

test("validateCompletionSignal rejects empty tool calls", () => {
  const result = validateCompletionSignal([]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.code, "empty_tool_calls");
  assert.match(result.issues[0]!.message, /complete_task/i);
  assert.match(result.issues[0]!.message, /exactly one/i);
});

test("validateCompletionSignal rejects batches with no complete_task at all", () => {
  const calls: ToolCall[] = [
    { id: "w", name: "write_file", args: { path: "a.txt", content: "x" } },
  ];
  const result = validateCompletionSignal(calls);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "empty_tool_calls");
});

test("validateCompletionSignal rejects mixed batches (complete_task + other tool)", () => {
  const calls: ToolCall[] = [
    completeTask(),
    { id: "w", name: "write_file", args: { path: "a.txt", content: "x" } },
  ];
  const result = validateCompletionSignal(calls);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "mixed_complete_task");
  assert.match(result.issues[0]!.message, /write_file/);
});

test("validateCompletionSignal rejects multiple complete_task calls in one batch", () => {
  const calls: ToolCall[] = [
    completeTask({ id: "c1" }),
    completeTask({ id: "c2" }),
  ];
  const result = validateCompletionSignal(calls);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "mixed_complete_task");
});

test("validateCompletionSignal rejects missing summary", () => {
  const call = { id: "c", name: "complete_task", args: {} as Record<string, unknown> } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "missing_summary");
  assert.equal(result.issues[0]!.field, "summary");
});

test("validateCompletionSignal rejects empty summary", () => {
  const call = { id: "c", name: "complete_task", args: { summary: "" } } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  // Empty string is "missing" — the gate treats empty and missing the same.
  assert.equal(result.issues[0]!.code, "missing_summary");
});

test("validateCompletionSignal rejects summary shorter than the minimum length", () => {
  const call = { id: "c", name: "complete_task", args: { summary: "done" } } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "summary_too_short");
  assert.equal(result.issues[0]!.field, "summary");
  assert.ok(
    result.issues[0]!.message.includes(String(COMPLETION_GATE_MIN_SUMMARY_CHARS)),
    "summary_too_short message should reference the min length constant",
  );
});

test("validateCompletionSignal rejects non-string summary", () => {
  const call = { id: "c", name: "complete_task", args: { summary: 42 as unknown as string } } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "summary_wrong_type");
});

test("validateCompletionSignal accepts a single, well-formed complete_task call", () => {
  const call = completeTask();
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected accept");
  assert.ok(result.summary.length >= COMPLETION_GATE_MIN_SUMMARY_CHARS);
});

test("validateCompletionSignal accepts structured fields when they are valid", () => {
  const call: ToolCall = {
    id: "c",
    name: "complete_task",
    args: {
      summary: "Reaper CLI was updated to expose the new strict completion gate behavior end-to-end.",
      verificationContract: {
        intent: "Verify the new strict completion gate behavior is exposed end-to-end.",
        commands: [
          { id: "unit", command: "npx vitest run tests/unit/completion-gate.test.ts", required: true },
        ],
        expectedArtifacts: ["src/runtime/completion-gate.ts", "src/runtime/engine.ts"],
      },
    },
  };
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, true);
});

test("validateCompletionSignal rejects invalid confidence", () => {
  const call = {
    id: "c",
    name: "complete_task",
    args: {
      summary: "Reaper CLI was updated to expose the new strict completion gate behavior end-to-end.",
      confidence: "very-high",
    },
  } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "confidence_invalid");
});

test("validateCompletionSignal rejects non-array files_changed", () => {
  const call = {
    id: "c",
    name: "complete_task",
    args: {
      summary: "Reaper CLI was updated to expose the new strict completion gate behavior end-to-end.",
      files_changed: "src/runtime/completion-gate.ts",
    },
  } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "files_changed_not_array");
});

test("validateCompletionSignal rejects empty-string entry in tests_run", () => {
  const call = {
    id: "c",
    name: "complete_task",
    args: {
      summary: "Reaper CLI was updated to expose the new strict completion gate behavior end-to-end.",
      tests_run: ["npm test", ""],
    },
  } as unknown as ToolCall;
  const result = validateCompletionSignal([call]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.equal(result.issues[0]!.code, "string_array_entry_invalid");
  assert.equal(result.issues[0]!.field, "tests_run");
});

test("renderCompletionGateRejectionFeedback renders all issues with codes", () => {
  const result = validateCompletionSignal([]);
  if (result.ok) throw new Error("expected rejection");
  const rendered = renderCompletionGateRejectionFeedback(result.issues);
  assert.match(rendered, /Reaper rejected/i);
  assert.match(rendered, /\[empty_tool_calls\]/);
});

test("runCompletionVerification runs /tests/run-tests.sh when it exists and reports pass on success", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "reaper-completion-gate-"));
  try {
    const testsPath = path.join(workspace, "tests");
    mkdirSync(testsPath, { recursive: true });
    writeFileSync(path.join(testsPath, "run-tests.sh"), "#!/bin/bash\necho OK\n");
    chmodSync(path.join(testsPath, "run-tests.sh"), 0o755);
    // The gate resolves /tests/run-tests.sh at the absolute root, so we
    // intentionally leave that path absent here. To exercise the verifier
    // we set the caller-provided command instead.
    process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND = `bash ${path.join(testsPath, "run-tests.sh")}`;
    const outcome = await runCompletionVerification({ workspaceRoot: workspace, completionArgs: {} });
    assert.equal(outcome.ok, true, `expected verifier pass; reason=${outcome.reason}`);
    assert.equal(outcome.commandKind, "caller_provided");
  } finally {
    delete process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runCompletionVerification reports failure when the caller-provided verifier fails", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "reaper-completion-gate-"));
  try {
    process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND = "false";
    const outcome = await runCompletionVerification({ workspaceRoot: workspace, completionArgs: {} });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.commandKind, "caller_provided");
    assert.match(outcome.reason, /Verification command 'false' failed/);
  } finally {
    delete process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runCompletionVerification runs the first tests_run entry when no caller command is set", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "reaper-completion-gate-"));
  try {
    delete process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND;
    const outcome = await runCompletionVerification({
      workspaceRoot: workspace,
      completionArgs: { tests_run: ["true", "should-not-run"] },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.commandKind, "model_referenced_tests_run");
    assert.match(outcome.command ?? "", /^true$/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runCompletionVerification rejects completion when no verifier is configured and no tests_run is provided", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "reaper-completion-gate-"));
  try {
    delete process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND;
    const outcome = await runCompletionVerification({ workspaceRoot: workspace, completionArgs: {} });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.commandKind, "skipped");
    assert.match(outcome.reason, /must provide a real verification command/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
