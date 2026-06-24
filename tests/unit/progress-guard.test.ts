import test from "node:test";
import assert from "node:assert/strict";

import { guardNoProgressToolCalls, reuseCachedSuccessfulActions } from "../../src/runtime/progress-guard.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";

test("same failing command trips the progress guard by the third repeat", () => {
  const previous = [failedShell("a", "node -e \"process.exit(1)\""), failedShell("b", "node   -e \"process.exit(1)\"")];
  const decision = guardNoProgressToolCalls([shellCall("c", "node -e \"process.exit(1)\"")], previous, {
    currentStepId: "step-1",
    actionRepeatLimit: 3,
    sameFailedActionLimit: 3,
    observationRepeatLimit: 3,
  });

  assert.equal(decision.tripped, true);
  assert.equal(decision.allowed.length, 0);
  assert.equal(decision.blockedResults.length, 1);
  assert.equal(decision.blockedResults[0]?.error?.code, "no_progress_loop_blocked");
  assert.equal(decision.trips[0]?.count, 3);
  assert.equal(decision.trips[0]?.planStepId, "step-1");
  assert.match(decision.trips[0]?.sig ?? "", /^run_shell_command::/);
});

test("distinct actions do not trip the progress guard", () => {
  const previous: ToolResult[] = [
    readResult("1", "src/a.ts"),
    readResult("2", "src/b.ts"),
    readResult("3", "src/c.ts"),
    readResult("4", "src/d.ts"),
  ];
  const decision = guardNoProgressToolCalls([readCall("5", "src/e.ts")], previous, {
    actionRepeatLimit: 3,
    sameFailedActionLimit: 3,
    observationRepeatLimit: 3,
  });

  assert.equal(decision.tripped, false);
  assert.equal(decision.allowed.length, 1);
  assert.equal(decision.blockedResults.length, 0);
});

test("same service recovery strategy is blocked on the second no-progress attempt", () => {
  const previous: ToolResult[] = [
    {
      toolCallId: "restart-1",
      name: "sandbox_service_control",
      ok: true,
      durationMs: 1,
      args: { action: "restart", service: "api" },
      output: { lifecycle: "starting" },
    },
  ];
  const decision = guardNoProgressToolCalls(
    [{ id: "restart-2", name: "sandbox_service_control", args: { action: "restart", service: "api" } }],
    previous,
    { recoveryStrategyRepeatLimit: 2 },
  );
  assert.equal(decision.tripped, true);
  assert.match(decision.feedback.join("\n"), /change diagnostic layer|root-cause hypothesis/i);
});

test("cached successful checks are reused only while no state change invalidates them", () => {
  const prior = successfulShell("check-1", "pytest -q");
  const cached = reuseCachedSuccessfulActions([shellCall("check-2", "pytest -q")], [prior]);
  assert.equal(cached.allowed.length, 0);
  assert.equal(cached.cachedResults[0]?.ok, true);
  assert.equal((cached.cachedResults[0]?.output as Record<string, unknown>).cachedSuccess, true);

  const afterMutation = reuseCachedSuccessfulActions(
    [shellCall("check-3", "pytest -q")],
    [prior, { toolCallId: "write", name: "write_file", ok: true, durationMs: 1, args: { path: "x", content: "y" }, output: {} }],
  );
  assert.equal(afterMutation.allowed.length, 1);
  assert.equal(afterMutation.cachedResults.length, 0);
});

function shellCall(id: string, cmd: string): ToolCall {
  return { id, name: "run_shell_command", args: { cmd } };
}

function readCall(id: string, filePath: string): ToolCall {
  return { id, name: "read_file", args: { path: filePath } };
}

function failedShell(id: string, cmd: string): ToolResult {
  return {
    toolCallId: id,
    name: "run_shell_command",
    ok: false,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 1, stdout: "", stderr: "" },
    error: { code: "shell_exit", message: `command failed ${id}` },
  };
}

function successfulShell(id: string, cmd: string): ToolResult {
  return {
    toolCallId: id,
    name: "run_shell_command",
    ok: true,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 0, stdout: "passed", stderr: "" },
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
