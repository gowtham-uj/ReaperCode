#!/usr/bin/env node
/**
 * scripts/run-unified-eval.ts — run coding-agent or context-days suites.
 *
 * Usage:
 *   npx tsx scripts/run-unified-eval.ts --suite coding-agent
 *   npx tsx scripts/run-unified-eval.ts --suite context-days
 *   npx tsx scripts/run-unified-eval.ts --task reaper_eval/suites/coding-agent/ca-fix-failing-tests.json
 *   npx tsx scripts/run-unified-eval.ts --suite coding-agent --provider minimax --model MiniMax-M3
 *
 * Requires MINIMAX_API_KEY (or the provider's key env) in the environment.
 * Does NOT push to git. Artifacts land under /tmp/reaper-eval-out/ by default.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadEvalTaskFile, runUnifiedEval } from "../reaper_eval/runtime/unified-eval.js";

interface CliOptions {
  suite?: "coding-agent" | "context-days";
  task?: string;
  provider: string;
  model: string;
  outputRoot: string;
  repoRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    provider: process.env.REAPER_EVAL_PROVIDER ?? "minimax",
    model: process.env.REAPER_EVAL_MODEL ?? "MiniMax-M3",
    outputRoot: process.env.REAPER_EVAL_OUT ?? "/tmp/reaper-eval-out",
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--suite" && next) {
      opts.suite = next as CliOptions["suite"];
      i += 1;
    } else if (a === "--task" && next) {
      opts.task = next;
      i += 1;
    } else if (a === "--provider" && next) {
      opts.provider = next;
      i += 1;
    } else if (a === "--model" && next) {
      opts.model = next;
      i += 1;
    } else if (a === "--output" && next) {
      opts.outputRoot = next;
      i += 1;
    } else if (a === "--repo-root" && next) {
      opts.repoRoot = next;
      i += 1;
    }
  }
  return opts;
}

async function listSuiteTasks(suite: string, repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, "reaper_eval", "suites", suite);
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)).sort();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const keyEnv = opts.provider === "minimax" ? "MINIMAX_API_KEY" : undefined;
  if (keyEnv && !process.env[keyEnv]) {
    console.error(`Missing ${keyEnv}. Export it before running live evals.`);
    process.exit(2);
  }

  let tasks: string[] = [];
  if (opts.task) {
    tasks = [path.isAbsolute(opts.task) ? opts.task : path.join(opts.repoRoot, opts.task)];
  } else if (opts.suite) {
    tasks = await listSuiteTasks(opts.suite, opts.repoRoot);
  } else {
    console.error("Pass --suite coding-agent|context-days or --task <path>");
    process.exit(2);
  }

  console.log(`Running ${tasks.length} task(s) with ${opts.provider}/${opts.model}`);
  console.log(`Artifacts → ${opts.outputRoot}`);

  const results = [];
  for (const taskPath of tasks) {
    console.log(`\n=== ${path.basename(taskPath)} ===`);
    const task = await loadEvalTaskFile(taskPath);
    const result = await runUnifiedEval({
      task,
      model: { provider: opts.provider, model: opts.model },
      outputRoot: opts.outputRoot,
      repoRoot: opts.repoRoot,
      keepWorkspace: true,
    });
    results.push(result);
    console.log(
      JSON.stringify(
        {
          taskId: result.taskId,
          status: result.status,
          passed: result.passed,
          modelCallCount: result.modelCallCount,
          outputDir: result.outputDir,
          modelIoPath: result.modelIoPath,
          gates: result.gates.map((g) => ({ type: g.type, passed: g.passed })),
          error: result.error,
          durationMs: result.durationMs,
        },
        null,
        2,
      ),
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed} passed, ${failed} failed / ${results.length} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
