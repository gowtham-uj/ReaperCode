import { readFile, writeFile } from "node:fs/promises";
import { runEvalTask, loadEvalInput } from "../reaper_eval/runtime/eval-lib.js";

async function main() {
  const taskPath = "reaper_eval/problem_sets/terminal-bench-reaper-tool-stress.json";
  const manifest = await loadEvalInput(taskPath);
  const task = manifest.tasks[0];

  console.log(`Running stress test: ${task.title}`);
  const summary = await runEvalTask(task);
  console.log("Summary:", JSON.stringify(summary, null, 2));

  if (summary.status !== "passed") {
    console.error("Run failed! See logs at:", summary.logRoot);
  } else {
    console.log("Stress test PASSED!");
    console.log("Trajectory log:", summary.trajectoryPath);
  }
}

main().catch(console.error);