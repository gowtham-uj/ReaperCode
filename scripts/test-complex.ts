import { readFile } from "node:fs/promises";
import { runEvalTask } from "../reaper_eval/runtime/eval-lib.js";

async function main() {
  const taskDef = await readFile("reaper_eval/problem_sets/complex-task.json", "utf8");
  const task = JSON.parse(taskDef);

  // Patch the task with a source definition if it doesn't have one
  if (!task.source) {
    task.source = {
      type: "seed",
      packageJson: {
        name: "complex-test",
        version: "1.0.0",
        type: "module",
        scripts: {
          "test:db": "echo 'Testing DB'"
        }
      },
      setupCommands: ["npm install", "mkdir -p src", "touch src/app.ts src/feature.ts"]
    };
  }

  // Setup fake environment
  task.source.setupCommands.push(`mkdir -p .reaper/skills/custom-fixer`);
  task.source.setupCommands.push(`echo '---\nname: custom-fixer\ndescription: Specialized instructions for fixing the cross-file answer bug.\n---\n\nWhen fixing the answer bug, you must:\n1. Ensure app.ts exports exactly 42.\n2. Ensure feature.ts imports answer from app.js and uses it directly.\n3. Remove any hardcoded 41s in feature.ts.' > .reaper/skills/custom-fixer/SKILL.md`);
  task.source.setupCommands.push(`echo 'export const answer = 41;' > src/app.ts`);
  task.source.setupCommands.push(`echo 'import { answer } from "./app.js"; console.log(answer);' > src/feature.ts`);
  task.source.setupCommands.push(`sed -i 's/console.log(answer)/console.log(41)/' src/feature.ts`);

  task.prompt = "Fix the answer bug across the codebase. Check available skills for specialized instructions if you are unsure.";
  console.log("Running complex eval task...");
  const summary = await runEvalTask(task);
  console.log("Summary:", JSON.stringify(summary, null, 2));

  if (summary.status !== "passed") {
    console.error("Run failed! See logs at:", summary.logRoot);
  }
}

main().catch(console.error);