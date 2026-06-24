import { runEvalTask, type EvalTask } from "../reaper_eval/runtime/eval-lib.js";

// Force DeepSeek before loadWorkspaceEnv reads .env
process.env.REAPER_LIVE_PROVIDER = "deepseek";
process.env.REAPER_EVAL_PROVIDER = "deepseek";
process.env.REAPER_EVAL_MODEL = "deepseek-chat";
process.env.REAPER_EVAL_API_KEY_ENV = "DEEPSEEK_API_KEY";

import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";
loadWorkspaceEnv("/workspace");

const task: EvalTask = {
  id: "smoke-task",
  title: "Smoke Test - Fix a simple file",
  prompt: `The file src/app.ts contains "export const answer = 41;". Change it to 42.`,
  verification: {
    command: "node -e \"const fs=require('fs'); const t=fs.readFileSync('src/app.ts','utf8'); if(!t.includes('42')){console.error('Expected 42'); process.exit(1)}\"",
    maxIterations: 2,
    allowJudgeRetry: false,
    lite: true,
  },
  source: {
    type: "seed",
    files: {
      "src/app.ts": "export const answer = 41;\n",
    },
  },
};

async function main() {
  console.log("[smoke-eval] Starting smoke eval task with DeepSeek...");
  console.log("[smoke-eval] Provider:", process.env.REAPER_LIVE_PROVIDER);
  console.log("[smoke-eval] Model:", process.env.REAPER_EVAL_MODEL);

  const summary = await runEvalTask(task);
  console.log("[smoke-eval] Result:", JSON.stringify({
    status: summary.status,
    durationMs: summary.durationMs,
    error: summary.error,
    assistantMessage: summary.assistantMessage?.slice(0, 200),
  }, null, 2));
  process.exit(summary.status === "passed" ? 0 : 1);
}

main().catch(console.error);
