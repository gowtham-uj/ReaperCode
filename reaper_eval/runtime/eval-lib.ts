import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { ConfiguredModelGateway } from "../../src/model/gateway.js";
import { ProviderMultiplexerClient } from "../../src/model/providers/provider-client.js";
import { createValidConfig, createValidRequestEnvelope } from "../../tests/fixtures/phase0.js";

const execFileAsync = promisify(execFile);

export interface EvalTask {
  id: string;
  title: string;
  description: string;
  targetRepo: string;
  targetRepoRef?: string;
  verification?: {
    command: string;
    maxIterations?: number;
    allowJudgeRetry?: boolean;
  };
}

export interface EvalSummary {
  task: EvalTask;
  status: "passed" | "failed" | "timeout" | "error";
  logRoot: string;
  trajectoryPath: string;
}

export interface EvalManifest {
  version: string;
  name: string;
  tasks: EvalTask[];
}

export async function loadEvalInput(filePath: string): Promise<EvalManifest> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as EvalManifest;
}

async function setupTargetRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });

  // package.json
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target",
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node --test isPalindrome.test.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  // buggy implementation: does not ignore case, includes spaces, returns string
  await writeFile(
    path.join(workspaceRoot, "isPalindrome.js"),
    `export function isPalindrome(text) {\n  const reversed = text.split('').reverse().join('');\n  return text + reversed;\n}\n`,
    "utf8",
  );

  // failing test
  await writeFile(
    path.join(workspaceRoot, "isPalindrome.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { isPalindrome } from "./isPalindrome.js";\n\ntest("palindrome detection", () => {\n  assert.equal(isPalindrome("A man a plan a canal Panama"), true);\n  assert.equal(isPalindrome("hello"), false);\n});\n`,
    "utf8",
  );

  // init git so checkpoint/diff tools work
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "stress@reaper.local"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Reaper Stress Test"], { cwd: workspaceRoot });
  await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "initial broken state"], { cwd: workspaceRoot });
}

export async function runEvalTask(task: EvalTask): Promise<EvalSummary> {
  const workspaceRoot = task.targetRepo.replace("file://", "");
  await setupTargetRepo(workspaceRoot);

  const logRoot = path.join("/tmp/reaper-stress-logs", task.id);
  await mkdir(logRoot, { recursive: true });

  const config = createValidConfig();
  config.models.default_model = {
    provider: "minimax",
    model: "MiniMax-M3",
    apiBase: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    timeoutMs: 300_000,
    maxRetries: 2,
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: false,
      embeddings: false,
      maxContextTokens: 131_000,
      maxOutputTokens: 4096,
    },
  };
  for (const role of Object.keys(config.modelRouting) as Array<keyof typeof config.modelRouting>) {
    config.modelRouting[role] = "default_model";
  }

  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: task.description,
    verification: {
      command: task.verification?.command ?? "npm test",
      maxIterations: task.verification?.maxIterations ?? 3,
      allowJudgeRetry: task.verification?.allowJudgeRetry ?? true,
    },
  };

  const modelGateway = new ConfiguredModelGateway(config, new ProviderMultiplexerClient());
  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway,
  });

  const result = await engine.run();
  const passed = result.verification?.ok ?? false;

  return {
    task,
    status: passed ? "passed" : "failed",
    logRoot,
    trajectoryPath: result.trajectoryPath,
  };
}
