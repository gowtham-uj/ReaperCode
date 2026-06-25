import { runEvalTask, loadEvalInput } from "../reaper_eval/runtime/eval-lib.js";

async function main() {
  const taskPath = "reaper_eval/problem_sets/terminal-bench-reaper-tool-stress.json";
  const taskId = process.argv[2];
  const manifest = await loadEvalInput(taskPath);
  const tasks = taskId ? manifest.tasks.filter((t) => t.id === taskId) : manifest.tasks;
  if (tasks.length === 0) {
    console.error(`No task with id ${taskId} found in ${taskPath}`);
    process.exit(1);
  }
  let failed = 0;
  for (const task of tasks) {
    console.log(`\n=== ${task.id}: ${task.title} ===`);
    const summary = await runEvalTask(task);
    console.log(`Status: ${summary.status}`);
    console.log(`  agent tests:    ${summary.details?.agentTestsPassed}`);
    console.log(`  original tests: ${summary.details?.originalTestPassed}`);
    console.log(`  modified tests: ${JSON.stringify(summary.details?.testFilesModified)}`);
    console.log(`  verification:   ${summary.details?.verificationOk}`);
    if (summary.status !== "passed") failed += 1;
  }
  console.log(`\n${tasks.length - failed}/${tasks.length} tasks passed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
