/**
 * reaper_eval/runtime/unified-eval.ts — single entry for coding + context evals.
 *
 * Stages workspace → runs RuntimeEngine → scores gates → packages artifacts
 * including full model I/O text transcripts.
 */

import { mkdir, mkdtemp, writeFile, readFile, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ConfiguredModelGateway } from "../../src/model/gateway.js";
import { CatalogProviderClient } from "../../src/model/catalog-provider-client.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidRequestEnvelope } from "../../tests/fixtures/phase0.js";
import { createLiveReaperConfig } from "../../tests/fixtures/live-gateway.js";
import { applyConfigToTunables } from "../../src/config/config-tunables.js";
import { resolveShellBinary } from "../../src/tools/global/bash.js";

import { parseEvalTask, type EvalTask } from "./task-schema.js";
import { scoreTask, type GateResult } from "./scorer.js";
import { collectEvalArtifacts } from "./artifact-collector.js";

const exec = promisify(execFile);

export interface UnifiedEvalModelOptions {
  provider: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface UnifiedEvalOptions {
  task: EvalTask | unknown;
  model: UnifiedEvalModelOptions;
  /** Where to write packaged artifacts. Default: /tmp/reaper-eval-out/<taskId>-<ts> */
  outputRoot?: string;
  /** Keep the staged workspace after the run (default true for inspection). */
  keepWorkspace?: boolean;
  /** Repo root for resolving fixtureDir paths. Default: process.cwd() */
  repoRoot?: string;
}

export interface UnifiedEvalResult {
  taskId: string;
  title: string;
  suite: string;
  status: "passed" | "failed" | "error";
  passed: boolean;
  gates: GateResult[];
  workspaceRoot: string;
  runId: string;
  outputDir: string;
  modelIoPath: string;
  trajectoryPath: string;
  modelCallCount: number;
  assistantMessage?: string;
  durationMs: number;
  error?: string;
  verification: { exitCode: number; command: string };
}

/**
 * Aggressive, eval-only context settings. All char-based thresholds derive
 * from the token cap exactly once so the in-memory config and staged project
 * config cannot drift and silently disable a required layer.
 */
export function buildStressContextManagement(softCap: number): Record<string, unknown> {
  const softCapChars = softCap * 4;
  return {
    softCap,
    shakeEnabled: true,
    shakeTriggerPct: 30,
    shakeProtectWindowChars: Math.min(64_000, Math.max(500, Math.floor(softCapChars * 0.02))),
    shakeMinSavingsChars: Math.max(500, Math.min(16_000, Math.floor(softCapChars * 0.02))),
    fullSummaryEnabled: true,
    fullSummaryCooldownMinToolBatches: 2,
    fullSummaryCooldownMinTokenGrowth: Math.max(1_500, Math.floor(softCap * 0.08)),
    fullSummaryMaxFilesToRestore: 2,
    fullSummaryFileTokenBudget: Math.max(1_000, Math.floor(softCap * 0.2)),
    bashHeadTailEnabled: true,
    bashPersistThresholdChars: Math.min(12_000, Math.max(4_000, Math.floor(softCapChars * 0.2))),
  };
}

export async function runUnifiedEval(options: UnifiedEvalOptions): Promise<UnifiedEvalResult> {
  const started = Date.now();
  const task = parseEvalTask(options.task);
  const repoRoot = options.repoRoot ?? process.cwd();
  const outputRoot = options.outputRoot ?? path.join(tmpdir(), "reaper-eval-out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(outputRoot, `${task.id}-${stamp}`);
  await mkdir(outputDir, { recursive: true });

  let workspaceRoot = "";
  let runId = "unknown";
  try {
    workspaceRoot = await stageWorkspace(task, repoRoot);
    await gitInit(workspaceRoot);
    await writeTaskSoftCap(workspaceRoot, task);

    const config = createLiveReaperConfig(options.model.provider, options.model.model);
    (config as any).verification = undefined;
    delete (config as any).verification;
    // Apply softCap into contextManagement so shake/full-summary use it.
    // Stress tasks also tighten bash head/tail so large tool output is
    // compacted under the same pressure window.
    if (typeof task.softCap === "number") {
      // Stress calibration: force each layer without reducing the retained
      // working set below the prompt/tool-schema footprint.
      (config as any).contextManagement = {
        ...((config as any).contextManagement ?? {}),
        ...buildStressContextManagement(task.softCap),
      };
    }
    applyConfigToTunables(config as any);

    const request = createValidRequestEnvelope();
    request.payload = {
      prompt: task.prompt,
      verification: {
        command: task.verification.command,
        maxIterations: task.verification.maxIterations,
      },
    };

    const modelGateway = new ConfiguredModelGateway(config, new CatalogProviderClient());
    const engine = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope: request,
      modelGateway,
    });
    const engineResult = await engine.run();
    runId =
      String((engineResult as any).runId ?? "") ||
      String((engineResult as any).state?.runId ?? "") ||
      findLatestRunId(workspaceRoot) ||
      "unknown";

    const verification = await runShell(workspaceRoot, task.verification.command);
    const trajSrc = path.join(workspaceRoot, ".reaper", "runs", runId, "logs", "reaper-trajectory.jsonl");
    const score = await scoreTask(task, {
      workspaceRoot,
      runId,
      trajectoryPath: existsSync(trajSrc) ? trajSrc : undefined,
      verification: { ...verification, command: task.verification.command },
    });

    const summary = {
      schema_version: 1,
      taskId: task.id,
      title: task.title,
      suite: task.suite,
      provider: options.model.provider,
      model: options.model.model,
      status: score.passed ? "passed" : "failed",
      passed: score.passed,
      gates: score.gates,
      runId,
      workspaceRoot,
      softCap: task.softCap ?? null,
      assistantMessage: (engineResult as any).assistantMessage ?? null,
      durationMs: Date.now() - started,
      verification: {
        command: task.verification.command,
        exitCode: verification.exitCode,
      },
    };

    const artifacts = await collectEvalArtifacts({
      workspaceRoot,
      runId,
      outputDir,
      taskId: task.id,
      verificationLog: [
        `$ ${task.verification.command}`,
        `exit=${verification.exitCode}`,
        "--- stdout ---",
        verification.stdout,
        "--- stderr ---",
        verification.stderr,
      ].join("\n"),
      summary,
    });

    // Also dump the prompt for reference
    await writeFile(path.join(outputDir, "PROMPT.md"), `# ${task.title}\n\n${task.prompt}\n`, "utf8");

    if (options.keepWorkspace === false) {
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      taskId: task.id,
      title: task.title,
      suite: task.suite,
      status: score.passed ? "passed" : "failed",
      passed: score.passed,
      gates: score.gates,
      workspaceRoot,
      runId,
      outputDir: artifacts.outputDir,
      modelIoPath: artifacts.modelIoPath,
      trajectoryPath: artifacts.trajectoryPath,
      modelCallCount: artifacts.modelCallCount,
      assistantMessage: (engineResult as any).assistantMessage,
      durationMs: Date.now() - started,
      verification: { exitCode: verification.exitCode, command: task.verification.command },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failSummary = {
      schema_version: 1,
      taskId: task.id,
      status: "error",
      error: message,
      durationMs: Date.now() - started,
    };
    await writeFile(path.join(outputDir, "result.json"), JSON.stringify(failSummary, null, 2), "utf8");
    return {
      taskId: task.id,
      title: task.title,
      suite: task.suite,
      status: "error",
      passed: false,
      gates: [],
      workspaceRoot,
      runId,
      outputDir,
      modelIoPath: path.join(outputDir, "MODEL_IO.md"),
      trajectoryPath: path.join(outputDir, "trajectory.jsonl"),
      modelCallCount: 0,
      durationMs: Date.now() - started,
      error: message,
      verification: { exitCode: -1, command: task.verification.command },
    };
  }
}

async function stageWorkspace(task: EvalTask, repoRoot: string): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), `reaper-ueval-${task.id}-`));
  if (task.fixtureDir) {
    const src = path.isAbsolute(task.fixtureDir)
      ? task.fixtureDir
      : path.join(repoRoot, task.fixtureDir);
    if (!existsSync(src)) {
      throw new Error(`fixtureDir not found: ${src}`);
    }
    // Copy fixture contents (including payload/ if present)
    await cp(src, workspaceRoot, { recursive: true });
  }
  for (const [rel, content] of Object.entries(task.projectFiles)) {
    const abs = path.join(workspaceRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return workspaceRoot;
}

async function writeTaskSoftCap(workspaceRoot: string, task: EvalTask): Promise<void> {
  if (typeof task.softCap !== "number") return;
  const dir = path.join(workspaceRoot, ".reaper");
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  existing.contextManagement = {
    ...((existing.contextManagement as object) ?? {}),
    ...buildStressContextManagement(task.softCap),
  };
  await writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");
}

async function gitInit(workspaceRoot: string): Promise<void> {
  await exec("git", ["init"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.email", "reaper-eval@local"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.name", "Reaper Eval"], { cwd: workspaceRoot });
  await exec("git", ["add", "-A"], { cwd: workspaceRoot });
  await exec("git", ["commit", "-m", "eval initial", "--allow-empty"], { cwd: workspaceRoot });
}

async function runShell(
  cwd: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Clear nvm/npm_config_prefix pollution that breaks `npm` inside bash -lc
  // in some cloud agent images, and ensure node/npm from the current PATH
  // remain visible.
  const env = {
    ...process.env,
    npm_config_prefix: "",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  delete (env as { npm_config_prefix?: string }).npm_config_prefix;
  try {
    const { stdout, stderr } = await exec(resolveShellBinary(), ["-c", command], {
      cwd,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function findLatestRunId(workspaceRoot: string): string | undefined {
  try {
    const runs = path.join(workspaceRoot, ".reaper", "runs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(runs)
      .map((name) => ({ name, mtime: statSync(path.join(runs, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.name;
  } catch {
    return undefined;
  }
}

export async function loadEvalTaskFile(filePath: string): Promise<EvalTask> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  // Back-compat: legacy tasks use `description` instead of `prompt`.
  if (raw && typeof raw === "object" && !("prompt" in (raw as object)) && "description" in (raw as object)) {
    const legacy = raw as Record<string, unknown>;
    return parseEvalTask({
      ...legacy,
      prompt: legacy.description,
      suite: legacy.suite ?? "legacy",
      gates: legacy.gates ?? [{ type: "verification_exit_0" }],
    });
  }
  return parseEvalTask(raw);
}
