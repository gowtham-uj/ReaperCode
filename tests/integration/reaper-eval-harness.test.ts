import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseEvalTask, scoreTask } from "../../src/eval/index.js";

/**
 * Smoke test that exercises the tracked eval schema + scorer against
 * an in-memory workspace. The original harness test reached into
 * `reaper_eval/runtime/reaper-eval-harness.js`, which lived in an
 * ignored workspace and required live models; that path is no longer
 * reachable from tracked tests. We cover the public surface that the
 * harness depended on (parseEvalTask + scoreTask) so the wiring stays
 * honest without depending on the removed eval infrastructure.
 */

test("parseEvalTask rejects tasks with no gates", () => {
  assert.throws(
    () =>
      parseEvalTask({
        id: "no-gates",
        title: "no gates",
        suite: "implementation",
        difficulty: "easy",
        language: "javascript",
        prompt: "do nothing",
        verification: { command: "node --test" },
        gates: [],
      }),
    /at least 1 element/i,
  );
});

test("scoreTask passes a verification_exit_0 gate when the run exited 0", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-harness-"));
  try {
    const task = parseEvalTask({
      id: "harness-self-test",
      title: "noop add",
      suite: "implementation",
      difficulty: "easy",
      language: "javascript",
      prompt: "noop",
      verification: { command: "node --test" },
      gates: [{ type: "verification_exit_0" }],
    });

    const result = await scoreTask(task, {
      workspaceRoot,
      runId: "run-1",
      trajectoryPath: path.join(workspaceRoot, "trajectory.jsonl"),
      verification: { exitCode: 0, stdout: "", stderr: "", command: "node --test" },
    });

    assert.equal(result.passed, true);
    assert.equal(result.gates.length, 1);
    assert.equal(result.gates[0]?.type, "verification_exit_0");
    assert.equal(result.gates[0]?.passed, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("scoreTask fails file_contains when the expected substring is missing", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-harness-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "index.js"),
      "export function inc(x) { return x; }\n",
      "utf8",
    );

    const task = parseEvalTask({
      id: "file-contains-self-test",
      title: "expects inc to return x+1",
      suite: "implementation",
      difficulty: "easy",
      language: "javascript",
      prompt: "noop",
      verification: { command: "node --test" },
      gates: [{ type: "file_contains", path: "src/index.js", contains: "return x + 1" }],
    });

    const result = await scoreTask(task, {
      workspaceRoot,
      runId: "run-2",
      trajectoryPath: path.join(workspaceRoot, "trajectory.jsonl"),
      verification: { exitCode: 0, stdout: "", stderr: "", command: "node --test" },
    });

    assert.equal(result.passed, false);
    assert.equal(result.gates[0]?.type, "file_contains");
    assert.equal(result.gates[0]?.passed, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});