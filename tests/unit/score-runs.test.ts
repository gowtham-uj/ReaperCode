import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatScore, scoreRunSet } from "../../scripts/score_runs.js";

test("scoreRunSet summarizes pass rate, timeouts, tool calls, repeats, and stop split", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-score-runs-"));
  try {
    const suiteDir = path.join(root, "suite");
    const taskDir = path.join(suiteDir, "task-a", "task-a.1-of-1");
    const logsDir = path.join(taskDir, "agent-logs", ".reaper", "runs", "run-1", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(suiteDir, "results.json"),
      JSON.stringify({
        results: [
          { id: "trial-a", trial_name: "task-a.1", task_id: "task-a", is_resolved: true },
          { id: "trial-b", trial_name: "task-b.1", task_id: "task-b", is_resolved: false, failure_mode: "timeout" },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(taskDir, "results.json"),
      JSON.stringify({ id: "trial-a", trial_name: "task-a.1", task_id: "task-a", is_resolved: true }),
      "utf8",
    );
    await writeFile(
      path.join(taskDir, "agent-logs", "reaper-terminal-bench-result.json"),
      JSON.stringify({ status: "failed", failureClass: "timeout", timedOut: true }),
      "utf8",
    );
    await writeFile(
      path.join(logsDir, "reaper-trajectory.jsonl"),
      `${JSON.stringify({
        kind: "session_metrics",
        total_tool_calls: 10,
        max_action_repeat: 3,
        stop_reason: "no_progress_stop",
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(logsDir, "..", "trajectory-metrics.json"),
      JSON.stringify({
        total_tool_calls: 4,
        max_action_repeat: 2,
        stop_reason: "harness_timeout",
      }),
      "utf8",
    );

    const summary = await scoreRunSet(root);

    assert.equal(summary.resultCount, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.passRate, 0.5);
    assert.equal(summary.harnessTimeouts, 2);
    assert.equal(summary.noProgressStops, 1);
    assert.equal(summary.medianToolCalls, 7);
    assert.equal(summary.maxToolCalls, 10);
    assert.equal(summary.medianIdenticalRepeat, 3);
    assert.equal(summary.maxIdenticalRepeat, 3);
    assert.match(formatScore(summary), /Pass rate: 50\.0%/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
