import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { scoreTask } from "../../reaper_eval/runtime/scorer.js";
import { parseEvalTask } from "../../reaper_eval/runtime/task-schema.js";

const task = parseEvalTask({
  id: "system-prompt-stability",
  title: "System prompt stability",
  suite: "context-days",
  difficulty: "stress",
  language: "typescript",
  prompt: "Exercise context replacement.",
  verification: { command: "node --test" },
  gates: [{ type: "system_prompt_stable_after_summary" }],
});

async function scoreSystems(t: TestContext, systems: string[], extraRecords: unknown[] = []) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-scorer-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const runId = "run-system-prompt-test";
  const runDir = path.join(workspaceRoot, ".reaper", "runs", runId);
  const modelCallDir = path.join(runDir, "model-calls");
  await mkdir(modelCallDir, { recursive: true });
  const summaryAt = "2026-07-13T10:00:02.000Z";
  const trajectoryPath = path.join(runDir, "logs", "reaper-trajectory.jsonl");
  await mkdir(path.dirname(trajectoryPath), { recursive: true });
  await writeFile(trajectoryPath, `${JSON.stringify({ kind: "full_summary", timestamp: summaryAt })}\n`, "utf8");
  for (const [index, system] of systems.entries()) {
    const startedAt = index === 0 ? "2026-07-13T10:00:01.000Z" : `2026-07-13T10:00:0${index + 2}.000Z`;
    await writeFile(
      path.join(modelCallDir, `${String(index + 1).padStart(4, "0")}-stream.json`),
      JSON.stringify({ startedAt, request: { system } }),
      "utf8",
    );
  }
  for (const [index, record] of extraRecords.entries()) {
    await writeFile(
      path.join(modelCallDir, `${String(systems.length + index + 1).padStart(4, "0")}-generate.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  return scoreTask(task, {
    workspaceRoot,
    runId,
    trajectoryPath,
    verification: { exitCode: 0, stdout: "", stderr: "", command: "node --test" },
  });
}

test("system-prompt stability gate passes when post-summary calls retain the baseline", async (t) => {
  const result = await scoreSystems(t, ["stable system", "stable system", "stable system"]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.gates[0]?.details, {
    calls: 3,
    postSummaryCalls: 2,
    mismatches: 0,
    missingSystems: 0,
    baselineChars: 13,
  });
});

test("system-prompt stability gate fails when context replacement changes the system", async (t) => {
  const result = await scoreSystems(t, ["stable system", "summary replaced system"]);
  assert.equal(result.passed, false);
  assert.equal(result.gates[0]?.details.mismatches, 1);
  assert.equal(result.gates[0]?.details.postSummaryCalls, 1);
});

test("system-prompt stability gate ignores judge calls without a system prompt", async (t) => {
  const result = await scoreSystems(
    t,
    ["stable system", "stable system", "stable system"],
    [{
      role: "judge",
      startedAt: "2026-07-13T10:00:05.000Z",
      request: { role: "judge", prompt: "score the run" },
    }],
  );
  assert.equal(result.passed, true);
  assert.equal(result.gates[0]?.details.calls, 3);
  assert.equal(result.gates[0]?.details.missingSystems, 0);
});
