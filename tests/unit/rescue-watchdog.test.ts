import test from "node:test";
import assert from "node:assert/strict";

import {
  createRescueWatchdogState,
  evaluateRescueWatchdog,
  getUnresolvedTaskContractVerificationBlocker,
} from "../../src/runtime/engine.js";
import type { ToolResult } from "../../src/tools/types.js";

function shellResult(id: string, cmd: string, ok: boolean, text: string): ToolResult {
  return {
    toolCallId: id,
    name: "run_shell_command",
    ok,
    durationMs: 1,
    args: { cmd },
    ...(ok
      ? { output: { exitCode: 0, stdout: text, stderr: "" } }
      : { error: { code: "COMMAND_FAILED", message: text }, output: { exitCode: 1, stdout: "", stderr: text } }),
  };
}

test("rescue watchdog trips repeated stagnant diagnostics before another rescuer call", () => {
  const patchRequest = {
    reasonPatchNeeded: "Rescue required: unresolved strict verification failure.",
    evidence: { failingCommand: "python -c \"assert actual == expected\"" },
  };
  const failure = shellResult("failed-check", "python -c \"assert actual == expected\"", false, "AssertionError: expected output");

  const first = evaluateRescueWatchdog({
    previous: createRescueWatchdogState(),
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure],
    maxAttemptsPerDiagnostic: 5,
    maxStagnantTurns: 2,
  });
  assert.equal(first.tripped, false);

  const second = evaluateRescueWatchdog({
    previous: first.state,
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure],
    maxAttemptsPerDiagnostic: 5,
    maxStagnantTurns: 2,
  });
  assert.equal(second.tripped, false);

  const third = evaluateRescueWatchdog({
    previous: second.state,
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure],
    maxAttemptsPerDiagnostic: 5,
    maxStagnantTurns: 2,
  });
  assert.equal(third.tripped, true);
  assert.match(third.reason, /no meaningful edit, producer, or strict verification progress/i);
});

test("rescue watchdog resets stagnation and attempt count after meaningful progress", () => {
  const patchRequest = { reasonPatchNeeded: "Rescue required: repair output." };
  const failure = shellResult("failed-check", "npm test", false, "missing db:init");
  const first = evaluateRescueWatchdog({
    previous: createRescueWatchdogState(),
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure],
    maxAttemptsPerDiagnostic: 3,
    maxStagnantTurns: 10,
  });
  const second = evaluateRescueWatchdog({
    previous: first.state,
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure],
    maxAttemptsPerDiagnostic: 3,
    maxStagnantTurns: 10,
  });
  const edit: ToolResult = {
    toolCallId: "edit",
    name: "replace_in_file",
    ok: true,
    durationMs: 1,
    args: { path: "package.json" },
  };
  const third = evaluateRescueWatchdog({
    previous: second.state,
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure, edit],
    maxAttemptsPerDiagnostic: 3,
    maxStagnantTurns: 10,
  });
  const fourth = evaluateRescueWatchdog({
    previous: third.state,
    stepId: "repair-output",
    patchRequest,
    toolResults: [failure, edit],
    maxAttemptsPerDiagnostic: 3,
    maxStagnantTurns: 10,
  });

  assert.equal(third.tripped, false);
  assert.equal(third.attempts, 1);
  assert.equal(third.state.stagnantTurns, 0);
  assert.equal(fourth.tripped, false);
  assert.equal(fourth.attempts, 2);
});

test("task-contract gate rejects a weaker print-only check after a failed assertion", () => {
  const strict = "python -c \"actual=7; expected=9; assert actual == expected\"";
  const weak = "python -c \"actual=7; expected=9; print(actual, expected)\"";
  const blocker = getUnresolvedTaskContractVerificationBlocker([
    shellResult("strict", strict, false, "AssertionError: 7 != 9"),
    shellResult("weak", weak, true, "7 9"),
  ]);

  assert.match(blocker ?? "", /strict task-contract check still fails/i);
  assert.match(blocker ?? "", /print-only or weaker check/i);
});

test("task-contract gate clears after the same strict check passes", () => {
  const strict = "python -c \"actual=9; expected=9; assert actual == expected\"";
  const blocker = getUnresolvedTaskContractVerificationBlocker([
    shellResult("strict-fail", strict, false, "AssertionError"),
    shellResult("strict-pass", strict, true, ""),
  ]);

  assert.equal(blocker, undefined);
});

test("task-contract gate clears after a formerly missing module imports successfully", () => {
  const blocker = getUnresolvedTaskContractVerificationBlocker([
    shellResult("import-fail", "python3 -c \"import example_pkg\"", false, "ModuleNotFoundError: No module named 'example_pkg'"),
    shellResult("import-pass", "python3 -c \"import example_pkg; print(example_pkg.__name__)\"", true, "example_pkg"),
  ]);

  assert.equal(blocker, undefined);
});
