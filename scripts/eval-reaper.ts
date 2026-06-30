import { readFile } from "node:fs/promises";
import { runEvalTask, type EvalTask } from "../reaper_eval/runtime/eval-lib.js";

async function main() {
  const prompt = await readFile("scripts/prompt.txt", "utf8");

  const task: EvalTask = {
    id: "distributed-ai-platform",
    title: "Distributed AI Workflow Platform",
    prompt: prompt,
    verification: {
      command: "npm test",
      maxIterations: 2,
      allowJudgeRetry: true,
    },
    source: {
      type: "seed",
      packageJson: {
        name: "distributed-ai-platform",
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node --test tests/**/*.test.ts"
        }
      },
      setupCommands: [
        "npm install"
      ]
    }
  };

  console.log("Running eval task...");
  const summary = await runEvalTask(task);
  console.log("Summary:", JSON.stringify(summary, null, 2));

  if (summary.status !== "passed") {
    console.error("Run failed! See logs at:", summary.logRoot);
  }
}

main().catch(console.error);