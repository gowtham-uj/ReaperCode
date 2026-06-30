import { runEvalTask, type EvalTask } from "../reaper_eval/runtime/eval-lib.js";
import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";

loadWorkspaceEnv("/workspace");

process.env.REAPER_LIVE_PROVIDER = "minimax";
process.env.REAPER_EVAL_PROVIDER = "minimax";
process.env.REAPER_MODEL_PROVIDER = "minimax";
process.env.REAPER_EVAL_MODEL = "MiniMax-M3";
process.env.MIMO_MODEL = "MiniMax-M3";
process.env.REAPER_EVAL_API_KEY_ENV = "MINIMAX_API_KEY";
process.env.REAPER_LIVE_FALLBACK_PROVIDERS = "";
process.env.REAPER_EVAL_INITIAL_CONCURRENCY = "1";
process.env.REAPER_LIVE_LOG_STDOUT = "1";

if (process.env.REAPER_EVAL_PROVIDER !== "minimax") {
  throw new Error(`wrong provider: ${process.env.REAPER_EVAL_PROVIDER}`);
}
if (!process.env.MINIMAX_API_KEY) {
  throw new Error("MINIMAX_API_KEY missing");
}

const task: EvalTask = {
  id: "initial-task-1",
  title: "Full-stack Task Management App",
  prompt: `Build a full-stack task management web application completely from scratch using any modern tech stack. The application must support user authentication, task creation, editing, deletion, filtering, persistent database storage, responsive UI, automated tests, Docker setup, and complete documentation. Plan the architecture, create the entire project structure, implement all features, debug runtime issues, and ensure the final application runs successfully end-to-end.`,
  verification: { command: "npm test", maxIterations: 3 },
};

console.log("[setup] provider=" + process.env.REAPER_EVAL_PROVIDER + " model=" + process.env.REAPER_EVAL_MODEL + " keyLen=" + process.env.MINIMAX_API_KEY.length);
const start = Date.now();
const summary = await runEvalTask(task);
console.log("[done]", summary.status, "durationMs=" + summary.durationMs, "elapsed=" + (Date.now() - start));
console.log("[workspace]", summary.workspaceRoot);
console.log("[logRoot]", summary.logRoot);
console.log("[verification]", JSON.stringify(summary.verification ?? null));
console.log("[assistant]", summary.assistantMessage?.slice(0, 1000));
console.log("[error]", summary.error?.slice(0, 1000));
