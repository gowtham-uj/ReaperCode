import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { classifyTestFileDiff } from "./test-diff.js";
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
  details?: {
    agentTestsPassed: boolean;
    originalTestPassed: boolean;
    testFilesModified: string[];
    /** Per-task test-file modification summary. */
    testFileChanges: TestFileChange[];
    verificationCommand: string;
    verificationOk: boolean;
  };
}

export interface TestFileChange {
  /** Path relative to workspace root. */
  path: string;
  /** "identical" | "extended" | "weakened" | "mutated" */
  kind: "identical" | "extended" | "weakened" | "mutated";
  addedNames: string[];
  removedNames: string[];
  changedNames: string[];
  loosenedNames: string[];
}

export interface EvalManifest {
  version: "1";
  name: string;
  tasks: EvalTask[];
}

export async function loadEvalInput(filePath: string): Promise<EvalManifest> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as EvalManifest;
}

/**
 * The initial failing test we ship with the target repo. We snapshot it
 * before the agent starts so we can re-run it after the agent is done.
 * If the agent modifies the test file to match its buggy implementation,
 * this snapshot lets us catch it: the agent's tests may pass while the
 * ORIGINAL tests still fail. This is the canonical Codex/Claude-style
 * safeguard against "writing tests that match the bug".
 */
const ORIGINAL_TEST_FILES = ["isPalindrome.test.js", "chunk.test.js", "parseJson.test.js"];

type TargetSetup = (workspaceRoot: string) => Promise<void>;

const testFileRepoMap: Record<string, string> = {
  "file:///tmp/reaper-stress-target": "isPalindrome.test.js",
  "file:///tmp/reaper-stress-target-chunk": "chunk.test.js",
  "file:///tmp/reaper-stress-target-json": "parseJson.test.js",
  "file:///tmp/reaper-stress-target-debounce": "utils.test.js",
  "file:///tmp/reaper-stress-target-truncate": "truncate.test.js",
};

const TARGET_SETUPS: Record<string, TargetSetup> = {
  "file:///tmp/reaper-stress-target": setupPalindromeRepo,
  "file:///tmp/reaper-stress-target-chunk": setupChunkRepo,
  "file:///tmp/reaper-stress-target-json": setupJsonRepo,
  "file:///tmp/reaper-stress-target-debounce": setupDebounceRepo,
  "file:///tmp/reaper-stress-target-truncate": setupTruncateRepo,
};

async function setupPalindromeRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test isPalindrome.test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "isPalindrome.js"),
    `export function isPalindrome(text) {\n  const reversed = text.split('').reverse().join('');\n  return text + reversed;\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "isPalindrome.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { isPalindrome } from "./isPalindrome.js";\n\ntest("palindrome detection", () => {\n  assert.equal(isPalindrome("A man a plan a canal Panama"), true);\n  assert.equal(isPalindrome("hello"), false);\n});\n`,
    "utf8",
  );
  await commitInitialState(workspaceRoot);
}

async function setupChunkRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target-chunk",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test chunk.test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  // Buggy chunk: off-by-one boundary produces extra empty chunk when length
  // is an exact multiple of size.
  await writeFile(
    path.join(workspaceRoot, "chunk.js"),
    `export function chunk(input, size) {\n  if (size <= 0) return input.slice();\n  const out = [];\n  for (let i = 0; i < input.length; i += size) {\n    out.push(input.slice(i, i + size));\n  }\n  // BUG: appends an empty chunk whenever the last slice was full.\n  if (input.length > 0 && input.length % size === 0) out.push([]);\n  return out;\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "chunk.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { chunk } from "./chunk.js";\n\ntest("chunks arrays of length 1", () => {\n  assert.deepEqual(chunk([1, 2, 3, 4, 5], 1), [[1], [2], [3], [4], [5]]);\n});\n\ntest("chunks arrays of length 2", () => {\n  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n});\n\ntest("chunks empty arrays", () => {\n  assert.deepEqual(chunk([], 3), []);\n});\n`,
    "utf8",
  );
  await commitInitialState(workspaceRoot);
}

async function setupJsonRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target-json",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test parseJson.test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  // Buggy: throws on invalid input.
  await writeFile(
    path.join(workspaceRoot, "parseJson.js"),
    `export function parseJson(text) {\n  return JSON.parse(text);\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "parseJson.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { parseJson } from "./parseJson.js";\n\ntest("parses valid JSON", () => {\n  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });\n});\n\ntest("returns null for invalid JSON", () => {\n  assert.equal(parseJson("{not valid}"), null);\n});\n`,
    "utf8",
  );
  await commitInitialState(workspaceRoot);
}

async function setupDebounceRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target-debounce",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test utils.test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  // No debounce exported yet — agent must add it.
  await writeFile(
    path.join(workspaceRoot, "utils.js"),
    `export function identity(x) {\n  return x;\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "utils.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { identity, debounce } from "./utils.js";\n\ntest("identity returns the input unchanged", () => {\n  assert.equal(identity(42), 42);\n  assert.equal(identity("hello"), "hello");\n});\n\ntest("debounce delays invocation by the wait time", async () => {\n  let calls = 0;\n  const fn = () => {\n    calls += 1;\n    return calls;\n  };\n  const debounced = debounce(fn, 30);\n  debounced();\n  debounced();\n  assert.equal(calls, 0);\n  await new Promise((resolve) => setTimeout(resolve, 80));\n  assert.equal(calls, 1);\n});\n`,
    "utf8",
  );
  await commitInitialState(workspaceRoot);
}

async function setupTruncateRepo(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "reaper-stress-target-truncate",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test truncate.test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  // Buggy truncate: ellipsis always appended even when not needed; off-by-one.
  await writeFile(
    path.join(workspaceRoot, "truncate.js"),
    `export function truncate(text, maxLength) {\n  if (text.length <= maxLength) return text + "...";\n  return text.slice(0, maxLength) + "...";\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "truncate.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { truncate } from "./truncate.js";\n\ntest("returns text unchanged when shorter than maxLength", () => {\n  assert.equal(truncate("hi", 10), "hi");\n});\n\ntest("truncates and appends an ellipsis when longer than maxLength", () => {\n  assert.equal(truncate("hello world", 5), "hello...");\n});\n\ntest("truncating exactly at the boundary", () => {\n  assert.equal(truncate("abcdef", 6), "abcdef");\n});\n`,
    "utf8",
  );
  await commitInitialState(workspaceRoot);
}

async function commitInitialState(workspaceRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "stress@reaper.local"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Reaper Stress Test"], { cwd: workspaceRoot });
  await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "initial broken state"], { cwd: workspaceRoot });
}

async function runShell(
  cwd: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const record = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: record.stdout ?? "",
      stderr: record.stderr ?? "",
      exitCode: typeof record.code === "number" ? record.code : 1,
    };
  }
}

export async function runEvalTask(task: EvalTask): Promise<EvalSummary> {
  const workspaceRoot = task.targetRepo.replace("file://", "");
  const setup = TARGET_SETUPS[task.targetRepo];
  if (!setup) throw new Error(`No setup defined for ${task.targetRepo}`);
  await setup(workspaceRoot);

  const testFile = path.basename(workspaceRoot).replace(/^reaper-stress-target/, "") + ".test.js";
  const testFileRel = testFileRepoMap[task.targetRepo] ?? "parseJson.test.js";

  const logRoot = path.join("/tmp/reaper-stress-logs", task.id);
  await mkdir(logRoot, { recursive: true });

  // Snapshot the original test files BEFORE the agent runs.
  const originalTestSnapshots = new Map<string, string>();
  for (const testFileName of [testFileRel]) {
    const testPath = path.join(workspaceRoot, testFileName);
    try {
      originalTestSnapshots.set(testFileName, await readFile(testPath, "utf8"));
    } catch {
      // Test file might not exist for this task; skip snapshot.
    }
  }

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

  // ---- Scaffold-level verification gate (Codex/Claude pattern) ----
  // The engine's verifier already re-runs the verification command
  // declared by the request. We additionally run:
  //   1. The agent's tests as-is (npm test) — already covered by
  //      result.verification?.ok when the agent's command matches.
  //   2. The ORIGINAL test files from setup, restored and re-run.
  //      If the agent modified the tests to match its buggy
  //      implementation, this run will still fail and reject the
  //      task even though the agent's tests pass.
  const verificationCommand = task.verification?.command ?? "npm test";

  // Run the agent's current test suite.
  const agentRun = await runShell(workspaceRoot, verificationCommand);
  const agentTestsPassed = agentRun.exitCode === 0;

  const testFileChanges = await detectTestFileChanges(workspaceRoot, originalTestSnapshots);
  const testFilesModified = testFileChanges.filter((c) => c.kind !== "identical").map((c) => c.path);
  const testsWeakened = testFileChanges.some((c) => c.kind === "weakened");

  // Restore the original test files and re-run them.
  const originalRun = await runOriginalTests(workspaceRoot, originalTestSnapshots, verificationCommand, testFileRel);
  const originalTestPassed = originalRun.exitCode === 0;

  // The engine verifier may not run if the agent never emitted
  // complete_task with a verification contract (model flakiness). In
  // that case fall back to the harness's own verification: the agent's
  // own tests passing AND the original baseline tests passing is enough
  // evidence the fix is real.
  const engineVerificationOk = result.verification?.ok === true;
  const harnessVerificationOk = agentTestsPassed && originalTestPassed;
  // Weakened tests (assertions relaxed, tests removed) invalidate the
  // fix even if the agent's tests pass — the run is rejected.
  const passed =
    !testsWeakened &&
    (engineVerificationOk || (result.verification === undefined && harnessVerificationOk));
  const verificationOk = engineVerificationOk || (result.verification === undefined && harnessVerificationOk);

  return {
    task,
    status: passed ? "passed" : "failed",
    logRoot,
    trajectoryPath: await findTrajectoryPath(workspaceRoot),
    details: {
      agentTestsPassed,
      originalTestPassed,
      testFilesModified,
      testFileChanges,
      verificationCommand,
      verificationOk,
    },
  };
}

async function detectTestFileChanges(
  workspaceRoot: string,
  snapshots: Map<string, string>,
): Promise<TestFileChange[]> {
  const changes: TestFileChange[] = [];
  for (const [name, originalContent] of snapshots) {
    let currentContent = originalContent;
    try {
      currentContent = await readFile(path.join(workspaceRoot, name), "utf8");
    } catch {
      // File missing — treat as fully removed; classify as weakened.
      changes.push({
        path: name,
        kind: "weakened",
        addedNames: [],
        removedNames: [],
        changedNames: [],
        loosenedNames: [],
      });
      continue;
    }
    const diff = classifyTestFileDiff(originalContent, currentContent);
    if (diff.kind === "identical") continue;
    changes.push({
      path: name,
      kind: diff.kind,
      addedNames: diff.addedNames,
      removedNames: diff.removedNames,
      changedNames: diff.changedNames,
      loosenedNames: diff.loosenedNames,
    });
  }
  return changes;
}

async function runOriginalTests(
  workspaceRoot: string,
  snapshots: Map<string, string>,
  command: string,
  testFileRel: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Restore the original test files in a temp directory, point the
  // runner at them, and run the verification command.
  const tempDir = await mkdtemp("reaper-original-tests-");
  try {
    for (const [name, content] of snapshots) {
      await writeFile(path.join(tempDir, name), content, "utf8");
    }
    // Run with a custom NODE_OPTIONS that includes the temp dir on the
    // require path; simplest is to just symlink package.json + the
    // current implementation files into the temp dir.
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "reaper-original-tests",
          version: "1.0.0",
          type: "module",
          scripts: { test: `node --test ${testFileRel}` },
        },
        null,
        2,
      ),
      "utf8",
    );
    // Copy the current implementation files into the temp dir.
    for (const file of [testFileRel]) {
      const impl = file.replace(/\.test\./, ".");
      try {
        const content = await readFile(path.join(workspaceRoot, impl), "utf8");
        await writeFile(path.join(tempDir, impl), content, "utf8");
      } catch {
        // If the implementation file no longer exists, the test will
        // fail naturally; that's fine.
      }
    }
    return await runShell(tempDir, command);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mkdtemp(prefix: string): Promise<string> {
  const dir = path.join("/tmp", `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function findTrajectoryPath(workspaceRoot: string): Promise<string> {
  try {
    const entries = await readFile(path.join(workspaceRoot, ".reaper", "LATEST_RUN"), "utf8");
    const runId = entries.trim();
    return path.join(workspaceRoot, ".reaper", "runs", runId, "logs", "reaper-trajectory.jsonl");
  } catch {
    return path.join(workspaceRoot, ".reaper", "logs", "reaper-trajectory.jsonl");
  }
}
