import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionMetricsSummary,
  computeMaxActionRepeat,
  normalizeArgs,
} from "../../src/runtime/session-metrics.js";
import type { ToolResult } from "../../src/tools/types.js";

test("normalizeArgs collapses whitespace and strips volatile tmp and timestamp tokens", () => {
  assert.equal(
    normalizeArgs("run_shell_command", {
      cmd: "pytest   /tmp/reaper-tbench-abc123/app  --log 2026-06-03T01:02:03.000Z",
    }),
    normalizeArgs("run_shell_command", {
      cmd: "pytest /tmp/reaper-tbench-def456/app --log 2026-06-03T04:05:06.000Z",
    }),
  );
});

test("computeMaxActionRepeat counts normalized identical actions", () => {
  const results: ToolResult[] = [
    shell("1", "pytest   /tmp/reaper-tbench-a/app"),
    shell("2", "pytest /tmp/reaper-tbench-b/app"),
    read("3", "src/runtime/engine.ts"),
    read("4", "src/runtime/engine.ts"),
    read("5", "src/runtime/session-metrics.ts"),
  ];

  assert.equal(computeMaxActionRepeat(results), 2);
});

test("buildSessionMetricsSummary emits phase 0 fields and stop reason", () => {
  const results: ToolResult[] = [
    shell("1", "npm test"),
    {
      ...shell("2", "npm test"),
      ok: false,
      error: { code: "no_progress_loop_blocked", message: "same action repeated" },
    },
  ];

  const summary = buildSessionMetricsSummary({
    toolResults: results,
    completionGateAttempts: 4,
    taskCompleted: false,
    verifiedCompletion: false,
  });

  assert.equal(summary.total_tool_calls, 2);
  assert.equal(summary.max_action_repeat, 2);
  assert.equal(summary.no_progress_trips, 1);
  assert.equal(summary.completion_gate_attempts, 4);
  assert.equal(summary.verified_completion, false);
  assert.equal(summary.stop_reason, "no_progress_stop");
});

function shell(id: string, cmd: string): ToolResult {
  return {
    toolCallId: id,
    name: "run_shell_command",
    ok: true,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 0, stdout: "", stderr: "" },
  };
}

function read(id: string, path: string): ToolResult {
  return {
    toolCallId: id,
    name: "read_file",
    ok: true,
    durationMs: 1,
    args: { path },
    output: { path, content: "" },
  };
}
