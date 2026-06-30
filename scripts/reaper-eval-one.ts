#!/usr/bin/env node
import { reaperEvalHarness, type EvalBenchTask } from "../reaper_eval/runtime/reaper-eval-harness.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: npx tsx scripts/reaper-eval-one.ts <task-id>");
  process.exit(1);
}

const taskPath = path.resolve(`reaper_eval/tasks/${taskId}.json`);
let task: EvalBenchTask;
try {
  task = JSON.parse(readFileSync(taskPath, "utf8")) as EvalBenchTask;
} catch (error) {
  console.error(`Failed to load task ${taskId} from ${taskPath}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

const provider = process.env.REAPER_EVAL_PROVIDER ?? "minimax";
const model = process.env.REAPER_EVAL_MODEL ?? "MiniMax-M3";
const summary = await reaperEvalHarness({ task, model: { provider, model }, maxIterations: 25, logStdout: true });
console.log(JSON.stringify(summary, null, 2));
if (summary.status !== "passed") process.exit(1);
