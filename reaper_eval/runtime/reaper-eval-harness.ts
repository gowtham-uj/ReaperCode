#!/usr/bin/env node
import { mkdir,  mkdtemp,  writeFile,  readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfiguredModelGateway } from "../../src/model/gateway.js";
import { CatalogProviderClient } from "../../src/model/catalog-provider-client.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidRequestEnvelope } from "../../tests/fixtures/phase0.js";
import { createLiveReaperConfig } from "../../tests/fixtures/live-gateway.js";

export interface EvalBenchTask {
  id: string;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  language: string;
  projectFiles: Record<string, string>;
  verification: { command: string };
}

export interface ReaperEvalOptions {
  task: EvalBenchTask;
  model: {
    provider: string;
    model: string;
    apiKey?: string;
    apiBase?: string;
    apiKeyEnv?: string;
    timeoutMs?: number;
  };
  maxIterations?: number;
  logLevel?: "debug" | "info" | "warn";
  logStdout?: boolean;
  trajectoryDir?: string;
}

async function stageTask(task: EvalBenchTask): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), `reaper-eval-${task.id}-`));
  for (const [rel, content] of Object.entries(task.projectFiles)) {
    const abs = path.join(workspaceRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return workspaceRoot;
}

async function gitInit(workspaceRoot: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.email", "reaper@local"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.name", "Reaper Eval"], { cwd: workspaceRoot });
  await exec("git", ["add", "."], { cwd: workspaceRoot });
  await exec("git", ["commit", "-m", "initial"], { cwd: workspaceRoot });
}

async function runShell(cwd: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout, stderr } = await promisify(execFile)("bash", ["-lc", command], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: typeof err.code === "number" ? err.code : 1 };
  }
}

export interface ReaperEvalResult {
  taskId: string;
  title: string;
  difficulty: string;
  status: "passed" | "failed" | "error" | "timeout";
  workspaceRoot: string;
  trajectoryPath: string;
  verificationOk: boolean;
  agentTestExitCode?: number;
  stopReason?: string;
  assistantMessage?: string;
  error?: string;
  stepCount: number;
}

export async function reaperEvalHarness(options: ReaperEvalOptions): Promise<ReaperEvalResult> {
  const workspaceRoot = await stageTask(options.task);
  await gitInit(workspaceRoot);

  const config = createLiveReaperConfig(options.model.provider, options.model.model);
  // The new harness expects verification to live on the request payload,
  // not on the config object. The default config may include a legacy
  // verification shape, so strip it to avoid strict-schema failures.
  (config as any).verification = undefined;
  delete (config as any).verification;

  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: options.task.description,
    verification: {
      command: options.task.verification.command,
      maxIterations: options.maxIterations ?? 3,
    },
  };

  let modelGateway;
  if (options.model.provider === "mock") {
    const { ConfiguredModelGateway } = await import("../../src/model/gateway.js");
    const mockClient = {
      async generate(_req: any, _prof: any) {
        throw new Error("mock not implemented");
      },
      async *stream(_req: any, _prof: any) {
        throw new Error("mock not implemented");
      },
      async embed() { throw new Error("mock not implemented"); },
    };
    modelGateway = new ConfiguredModelGateway(config, mockClient as any);
  } else {
    // Use the new catalog-based adapter so any provider declared in
    // src/model/provider/catalog.ts can be driven end-to-end.
    modelGateway = new ConfiguredModelGateway(config, new CatalogProviderClient());
  }

  const engine = new RuntimeEngine({ config, workspaceRoot, requestEnvelope: request, modelGateway });
  const result = await engine.run();

  const run = await runShell(workspaceRoot, options.task.verification.command);
  const trajectoryDir = options.trajectoryDir ?? "/tmp/reaper-eval-trajectories";
  const trajectoryPath = path.join(trajectoryDir, `${options.task.id}.jsonl`);
  await mkdir(trajectoryDir, { recursive: true });
  // Best-effort copy trajectory from engine logs. Fall back to the
  // workspace run directory if the result object does not expose a path.
  const src = (result as any).trajectoryPath
    ? String((result as any).trajectoryPath)
    : path.join(workspaceRoot, ".reaper", "runs", (result as any).runId ?? "unknown", "logs", "reaper-trajectory.jsonl");
  try {
    await writeFile(trajectoryPath, await readFile(src, "utf8"), "utf8");
  } catch {
    await writeFile(trajectoryPath, "{}", "utf8");
  }

  const status = run.exitCode === 0 ? "passed" : result.verification?.ok === true ? "passed" : "failed";
  return {
    taskId: options.task.id,
    title: options.task.title,
    difficulty: options.task.difficulty,
    status,
    workspaceRoot,
    trajectoryPath,
    verificationOk: run.exitCode === 0,
    agentTestExitCode: run.exitCode,
    stopReason: (result as any).stopReason,
    assistantMessage: result.assistantMessage,
    stepCount: (result as any).stepCount ?? 0,
  };
}
