import { loadWorkspaceEnv } from "../reaper_eval/runtime/load-env.js";

loadWorkspaceEnv("/workspace");
console.log("LIVE_PROVIDER=" + process.env.REAPER_LIVE_PROVIDER);
console.log("EVAL_PROVIDER=" + process.env.REAPER_EVAL_PROVIDER);
console.log("EVAL_MODEL=" + process.env.REAPER_EVAL_MODEL);
console.log("EVAL_API_KEY_ENV=" + process.env.REAPER_EVAL_API_KEY_ENV);
console.log("MINIMAX_API_KEY length=" + (process.env.MINIMAX_API_KEY || "").length);
