import { runEvalTask, type EvalTask } from "../reaper_eval/runtime/eval-lib.js";
import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";

// Force DeepSeek provider before .env is loaded
process.env.REAPER_LIVE_PROVIDER = "deepseek";
process.env.REAPER_EVAL_PROVIDER = "deepseek";
process.env.REAPER_EVAL_MODEL = process.env.REAPER_EVAL_MODEL ?? "deepseek-chat";
process.env.REAPER_EVAL_API_KEY_ENV = process.env.REAPER_EVAL_API_KEY_ENV ?? "DEEPSEEK_API_KEY";

loadWorkspaceEnv("/workspace");

const task: EvalTask = {
  id: "simple-math-fix",
  title: "Simple Math Fix",
  prompt: `The file src/app.ts contains "export const answer = 41;". Change it to 42.`,
  verification: {
    command: "node -e \"const fs=require('fs'); const t=fs.readFileSync('src/app.ts','utf8'); if(!t.includes('42')){console.error('Expected 42'); process.exit(1)}\"",
    maxIterations: 2,
    allowJudgeRetry: false,
  },
  source: {
    type: "seed",
    files: {
      "src/app.ts": "export const answer = 41;\n",
    },
  },
};

async function main() {
  const missingEnv = getMissingProviderEnv();
  if (missingEnv) {
    console.error(`[preflight] Missing ${missingEnv}; set it before launching.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[eval] Starting task: ${task.id} with provider=${process.env.REAPER_LIVE_PROVIDER} model=${process.env.REAPER_EVAL_MODEL}`);
  const summary = await runEvalTask(task);
  console.log("[eval] Result:", JSON.stringify({
    status: summary.status,
    durationMs: summary.durationMs,
    error: summary.error,
    assistantMessage: summary.assistantMessage?.slice(0, 200),
  }, null, 2));
  process.exit(summary.status === "passed" ? 0 : 1);
}

function getMissingProviderEnv(): string | undefined {
  const apiKeyEnv = process.env.REAPER_EVAL_API_KEY_ENV ?? "DEEPSEEK_API_KEY";
  return process.env[apiKeyEnv] ? undefined : apiKeyEnv;
}

main().catch(console.error);
