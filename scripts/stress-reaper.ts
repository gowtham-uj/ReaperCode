#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RuntimeEngine } from "../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../tests/fixtures/phase0.js";

import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../src/model/types.js";

export const TASKS = [
  {
    id: "reaper-stress-001",
    title: "Fix case-insensitive palindrome checker",
    prompt: "Make the palindrome checker ignore case and non-alphanumeric characters. 'A man, a plan, a canal: Panama' should be a palindrome.",
    implFile: "src/palindrome.js",
    testFile: "tests/palindrome.test.js",
    buggyImpl: `export function isPalindrome(str) {\n  return str === str.split("").reverse().join("");\n}\n`,
    testImpl: `import { isPalindrome } from "../src/palindrome.js";\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("recognizes palindromes", () => {\n  assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true);\n  assert.equal(isPalindrome("race a car"), false);\n});\n`,
    fix: {
      oldString: `export function isPalindrome(str) {\n  return str === str.split("").reverse().join("");\n}`,
      newString: `export function isPalindrome(str) {\n  const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, "");\n  return cleaned === cleaned.split("").reverse().join("");\n}`,
    },
  },
  {
    id: "reaper-stress-002",
    title: "Fix array chunking off-by-one",
    prompt: "The chunk helper produces an extra empty chunk at the end. Remove it.",
    implFile: "src/chunk.js",
    testFile: "tests/chunk.test.js",
    buggyImpl: `export function chunk(arr, size) {\n  const result = [];\n  for (let i = 0; i <= arr.length; i += size) {\n    result.push(arr.slice(i, i + size));\n  }\n  return result;\n}\n`,
    testImpl: `import { chunk } from "../src/chunk.js";\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("chunks evenly", () => {\n  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);\n});\n`,
    fix: {
      oldString: `  for (let i = 0; i <= arr.length; i += size) {`,
      newString: `  for (let i = 0; i < arr.length; i += size) {`,
    },
  },
  {
    id: "reaper-stress-003",
    title: "Make JSON parser return null for invalid input",
    prompt: "The parseJson helper currently throws when given invalid JSON. Change it to return null instead.",
    implFile: "src/parseJson.js",
    testFile: "tests/parseJson.test.js",
    buggyImpl: `export function parseJson(text) {\n  return JSON.parse(text);\n}\n`,
    testImpl: `import { parseJson } from "../src/parseJson.js";\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("returns null for invalid JSON", () => {\n  assert.equal(parseJson("not json"), null);\n});\ntest("parses valid JSON", () => {\n  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });\n});\n`,
    fix: {
      oldString: `export function parseJson(text) {\n  return JSON.parse(text);\n}`,
      newString: `export function parseJson(text) {\n  try {\n    return JSON.parse(text);\n  } catch {\n    return null;\n  }\n}`,
    },
  },
] as const;

export type StressTask = (typeof TASKS)[number];

export async function setupStressTask(task: StressTask, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(path.join(targetRoot, "src"), { recursive: true });
  await mkdir(path.join(targetRoot, "tests"), { recursive: true });
  await writeFile(path.join(targetRoot, task.implFile), task.buggyImpl, "utf8");
  await writeFile(path.join(targetRoot, task.testFile), task.testImpl, "utf8");
  await writeFile(
    path.join(targetRoot, "package.json"),
    JSON.stringify({ name: "stress-target", version: "1.0.0", type: "module", scripts: { test: "node --test tests/" } }, null, 2),
    "utf8",
  );
  await gitInit(targetRoot);
}

async function gitInit(root: string): Promise<void> {
  await runCommand("git", ["init", "-q"], root);
  await runCommand("git", ["config", "user.email", "stress@example.com"], root);
  await runCommand("git", ["config", "user.name", "Stress"], root);
  await runCommand("git", ["add", "."], root);
  await runCommand("git", ["commit", "-q", "-m", "initial"], root);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Command failed: ${command} ${args.join(" ")}`))));
  });
}

export async function snapshotOriginalTests(task: StressTask, targetRoot: string, snapshotDir: string): Promise<void> {
  await mkdir(snapshotDir, { recursive: true });
  await cp(path.join(targetRoot, task.testFile), path.join(snapshotDir, path.basename(task.testFile)));
}

export async function verifyWithOriginalTests(task: StressTask, agentRoot: string, snapshotDir: string): Promise<boolean> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "reaper-stress-verify-"));
  try {
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await mkdir(path.join(tempDir, "tests"), { recursive: true });
    await cp(path.join(agentRoot, task.implFile), path.join(tempDir, task.implFile));
    await cp(path.join(snapshotDir, path.basename(task.testFile)), path.join(tempDir, task.testFile));
    await cp(path.join(agentRoot, "package.json"), path.join(tempDir, "package.json"));
    const { exitCode } = await runShell("npm test", tempDir);
    return exitCode === 0;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runShell(cmd: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

const MOCK_PROFILE: ResolvedModelProfile = {
  role: "main_reasoner",
  profileName: "main_reasoner",
  provider: "mock",
  model: "mock",
  capabilities: {
    streaming: false,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
    maxContextTokens: 131_000,
    maxOutputTokens: 8192,
  },
};

export class ScriptedCodingAgentGateway implements ModelGateway {
  private step = 0;
  constructor(private readonly task: StressTask) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return { ...MOCK_PROFILE, role, profileName: role };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const role = request.role ?? "main_reasoner";
    if (role !== "main_reasoner") {
      return {
        role,
        profileName: role,
        provider: "mock",
        model: "mock",
        content: "noop",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    }

    const sequence = this.buildSequence();
    const response = sequence[this.step];
    this.step += 1;
    if (!response) {
      return {
        role,
        profileName: role,
        provider: "mock",
        model: "mock",
        content: "Done.",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    }
    return response;
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResult> {
    return { role: "embedder", profileName: "embedder", provider: "mock", model: "mock", vectors: [], raw: {} };
  }

  async *stream(_req: GenerateRequest): AsyncGenerator<StreamEvent> {
    return;
  }

  async countTokens(_req: TokenCountRequest): Promise<number> {
    return 0;
  }

  private mockResult(content: string, toolCalls: unknown[]): GenerateResult {
    return {
      role: "main_reasoner",
      profileName: "main_reasoner",
      provider: "mock",
      model: "mock",
      content,
      toolCalls,
      finishReason: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 50 },
      raw: {},
    };
  }

  private buildSequence(): GenerateResult[] {
    const t = this.task;
    return [
      this.mockResult("Reading the implementation file.", [
        { id: "read-impl", name: "read_file", args: { path: t.implFile } },
      ]),
      this.mockResult("Applying the fix.", [
        {
          id: "replace-impl",
          name: "replace_in_file",
          args: { path: t.implFile, ...t.fix },
        },
      ]),
      this.mockResult("Running the test suite.", [
        { id: "run-test", name: "bash", args: { cmd: "npm test", summary: "run tests" } },
      ]),
      this.mockResult("Fix verified by tests.", [
        {
          id: "complete",
          name: "complete_task",
          args: {
            summary: `${t.title} fixed and verified.`,
            verificationContract: { commands: [{ command: "npm test", required: true }] },
          },
        },
      ]),
    ];
  }
}

export interface StressTaskResult {
  id: string;
  title: string;
  status: "passed" | "failed";
  agentTestsPassed: boolean;
  originalTestsPassed: boolean;
  engineVerificationOk: boolean;
  error?: string | undefined;
}

export async function runStressTask(task: StressTask): Promise<StressTaskResult> {
  const targetRoot = await mkdtemp(path.join(tmpdir(), `${task.id}-`));
  const snapshotDir = path.join(targetRoot, ".stress-snapshot");
  try {
    await setupStressTask(task, targetRoot);
    await snapshotOriginalTests(task, targetRoot, snapshotDir);

    const engineResult = await new RuntimeEngine({
      config: createValidConfig(),
      workspaceRoot: targetRoot,
      requestEnvelope: { ...createValidRequestEnvelope(), payload: { prompt: `${task.title}. ${task.prompt}` } },
      modelGateway: new ScriptedCodingAgentGateway(task),
    }).run();

    const agentTestsPassed = engineResult.verification?.ok === true;
    const originalTestsPassed = await verifyWithOriginalTests(task, targetRoot, snapshotDir);
    const engineVerificationOk = engineResult.verification?.ok === true;
    const passed = agentTestsPassed && originalTestsPassed;

    return {
      id: task.id,
      title: task.title,
      status: passed ? "passed" : "failed",
      agentTestsPassed,
      originalTestsPassed,
      engineVerificationOk,
      error: passed ? undefined : `${agentTestsPassed ? "" : "agent tests failed; "}${originalTestsPassed ? "" : "original tests failed; "}`,
    };
  } catch (error) {
    return { id: task.id, title: task.title, status: "failed", agentTestsPassed: false, originalTestsPassed: false, engineVerificationOk: false, error: String(error) };
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
}

export async function runStressSuite(): Promise<StressTaskResult[]> {
  const results: StressTaskResult[] = [];
  for (const task of TASKS) {
    results.push(await runStressTask(task));
  }
  return results;
}

async function main(): Promise<void> {
  console.log("=== Reaper Pi-parity stress harness ===");
  const runs = Math.max(1, Number(process.env.REAPER_STRESS_RUNS ?? "3"));
  let allPassed = true;
  for (let run = 1; run <= runs; run += 1) {
    console.log("");
    console.log(`--- Run ${run}/${runs} ---`);
    const results = await runStressSuite();
    const passed = results.filter((r) => r.status === "passed").length;
    console.log(`${passed}/${results.length} tasks passed`);
    for (const r of results) {
      console.log(`- ${r.id}: ${r.status} (agent=${r.agentTestsPassed}, original=${r.originalTestsPassed}, engine=${r.engineVerificationOk})`);
      if (r.error) console.log(`  error: ${r.error}`);
    }
    if (passed !== results.length) allPassed = false;
  }
  console.log("");
  console.log("=== Final ===");
  console.log(allPassed ? "All runs passed" : "Some runs failed");
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
