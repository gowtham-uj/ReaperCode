/**
 * reaper_eval/runtime/artifact-collector.ts — package run artifacts for humans.
 *
 * Copies trajectory, model-call JSON+TXT transcripts, verification logs,
 * scratchpad, and summaries into a single eval output directory.
 */

import { cp, mkdir, writeFile, readFile, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { collectModelCallTranscripts } from "../../src/logging/model-call-log.js";

export interface ArtifactCollectorInput {
  workspaceRoot: string;
  runId: string;
  outputDir: string;
  taskId: string;
  verificationLog?: string;
  summary?: Record<string, unknown>;
}

export interface ArtifactCollectorResult {
  outputDir: string;
  modelIoPath: string;
  trajectoryPath: string;
  modelCallCount: number;
  files: string[];
}

export async function collectEvalArtifacts(input: ArtifactCollectorInput): Promise<ArtifactCollectorResult> {
  const { workspaceRoot, runId, outputDir, taskId } = input;
  await mkdir(outputDir, { recursive: true });
  const files: string[] = [];

  const runDir = path.join(workspaceRoot, ".reaper", "runs", runId);
  const trajSrc = path.join(runDir, "logs", "reaper-trajectory.jsonl");
  const trajDest = path.join(outputDir, "trajectory.jsonl");
  if (existsSync(trajSrc)) {
    await copyFile(trajSrc, trajDest);
    files.push("trajectory.jsonl");
  } else {
    await writeFile(trajDest, "", "utf8");
  }

  // Full model I/O as one readable markdown doc
  const modelIoPath = path.join(outputDir, "MODEL_IO.md");
  const collected = await collectModelCallTranscripts(workspaceRoot, runId, modelIoPath);
  files.push("MODEL_IO.md");

  // Also copy the raw model-calls directory for per-call JSON+TXT
  const modelCallsSrc = path.join(runDir, "model-calls");
  const modelCallsDest = path.join(outputDir, "model-calls");
  if (existsSync(modelCallsSrc)) {
    await cp(modelCallsSrc, modelCallsDest, { recursive: true });
    files.push("model-calls/");
  }

  // Scratchpad + summaries (days-long continuity artifacts)
  const scratchSrc = path.join(workspaceRoot, ".reaper", "memory", "scratch.md");
  if (existsSync(scratchSrc)) {
    await copyFile(scratchSrc, path.join(outputDir, "scratchpad.md"));
    files.push("scratchpad.md");
  }
  const summariesSrc = path.join(workspaceRoot, ".reaper", "summaries");
  if (existsSync(summariesSrc)) {
    await cp(summariesSrc, path.join(outputDir, "summaries"), { recursive: true });
    files.push("summaries/");
  }

  if (input.verificationLog) {
    await writeFile(path.join(outputDir, "verification.log"), input.verificationLog, "utf8");
    files.push("verification.log");
  }

  if (input.summary) {
    await writeFile(path.join(outputDir, "result.json"), JSON.stringify(input.summary, null, 2), "utf8");
    files.push("result.json");
  }

  // Index README for humans
  const readme = [
    `# Eval artifacts — ${taskId}`,
    ``,
    `- runId: \`${runId}\``,
    `- workspace: \`${workspaceRoot}\``,
    `- model calls: ${collected.calls}`,
    ``,
    `## How to inspect what the model saw`,
    ``,
    `1. Open \`MODEL_IO.md\` — chronological transcript of every model call (system + messages + output).`,
    `2. Or browse \`model-calls/NNNN-generate.txt\` for a single call.`,
    `3. \`trajectory.jsonl\` has tool_call / context_shake / token_budget events.`,
    `4. \`scratchpad.md\` / \`summaries/\` show days-long continuity artifacts when present.`,
    ``,
  ].join("\n");
  await writeFile(path.join(outputDir, "README.md"), readme, "utf8");
  files.push("README.md");

  return {
    outputDir,
    modelIoPath,
    trajectoryPath: trajDest,
    modelCallCount: collected.calls,
    files,
  };
}

export async function listModelCallTxtFiles(workspaceRoot: string, runId: string): Promise<string[]> {
  const dir = path.join(workspaceRoot, ".reaper", "runs", runId, "model-calls");
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".txt") && f !== "TRANSCRIPT.md").sort();
  } catch {
    return [];
  }
}
