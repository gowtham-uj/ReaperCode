#!/usr/bin/env node
import { reaperEvalHarness, type EvalBenchTask } from "../reaper_eval/runtime/reaper-eval-harness.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TASK_DIR = "reaper_eval/tasks";

function loadTasks(): EvalBenchTask[] {
  const files = readdirSync(TASK_DIR).filter((name) => name.endsWith(".json"));
  files.sort();
  return files.map((file) => JSON.parse(readFileSync(path.join(TASK_DIR, file), "utf8")) as EvalBenchTask);
}

async function main() {
  const provider = process.env.REAPER_EVAL_PROVIDER ?? "minimax";
  const model = process.env.REAPER_EVAL_MODEL ?? "MiniMax-M3";
  const tasks = loadTasks();
  const results = [];
  for (const task of tasks) {
    console.log(`\n=== ${task.id} [${task.difficulty}] ===`);
    const summary = await reaperEvalHarness({
      task,
      model: { provider, model },
      maxIterations: 25,
      logStdout: true,
    });
    console.log("status:", summary.status);
    console.log("verificationOk:", summary.verificationOk);
    if (summary.agentTestExitCode !== undefined) console.log("agentTestExitCode:", summary.agentTestExitCode);
    console.log("workspace:", summary.workspaceRoot);
    console.log("trajectory:", summary.trajectoryPath);
    results.push(summary);
  }
  const passed = results.filter((r) => r.status === "passed").length;
  console.log(`\nTOTAL ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
