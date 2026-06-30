import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { allocateFileLeases } from "../../src/orchestration/leases.js";
import { detectPlanCycle, nextSchedulableTasks } from "../../src/orchestration/scheduler.js";
import { createSandboxWorkspace, cleanupSandboxWorkspace } from "../../src/orchestration/sandbox.js";
import { runIntegratorMerge } from "../../src/orchestration/integrator.js";
import { runDelegatedPlan } from "../../src/orchestration/sub-agents.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import type { ToolCall } from "../../src/tools/types.js";

test("DAG scheduler only releases tasks whose dependencies are satisfied", async () => {
  const plan = [
    { id: "a", title: "A", prompt: "A", verificationCommand: "node -e \"process.exit(0)\"", dependsOn: [], files: ["src/a.ts"] },
    { id: "b", title: "B", prompt: "B", verificationCommand: "node -e \"process.exit(0)\"", dependsOn: ["a"], files: ["src/b.ts"] },
    { id: "c", title: "C", prompt: "C", verificationCommand: "node -e \"process.exit(0)\"", dependsOn: [], files: ["src/c.ts"] },
  ];

  detectPlanCycle(plan);
  const first = nextSchedulableTasks(plan, new Set(), new Set(), 3).map((task) => task.id).sort();
  const second = nextSchedulableTasks(plan, new Set(["a"]), new Set(), 3).map((task) => task.id).sort();

  assert.deepEqual(first, ["a", "c"]);
  assert.deepEqual(second, ["b", "c"]);
});

test("sandbox workspaces isolate branch changes until merged", async () => {
  const workspaceRoot = await createTempWorkspace();
  const sandbox = await createSandboxWorkspace(workspaceRoot, "session-1", "task-1");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(sandbox.worktreePath, "src", "app.ts"), "export const answer = 100;\n", "utf8"));
    const mainFile = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
    const sandboxFile = await readFile(path.join(sandbox.worktreePath, "src", "app.ts"), "utf8");
    assert.match(mainFile, /41/);
    assert.match(sandboxFile, /100/);
  } finally {
    await cleanupSandboxWorkspace(workspaceRoot, sandbox);
  }
});

test("integrator merges successful subtask branches back into the parent workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const sandboxA = await createSandboxWorkspace(workspaceRoot, "session-1", "task-a");
  const sandboxB = await createSandboxWorkspace(workspaceRoot, "session-1", "task-b");

  try {
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", sandboxA.worktreePath, "checkout", sandboxA.branchName], (error) => (error ? reject(error) : resolve()));
      }),
    );
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(sandboxA.worktreePath, "src", "a.ts"), "export const a = 1;\n", "utf8"));
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", sandboxA.worktreePath, "add", "."], (error) => (error ? reject(error) : resolve()));
      }),
    );
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", sandboxA.worktreePath, "commit", "-m", "task a"], { env: { ...process.env, GIT_AUTHOR_NAME: "Reaper Tests", GIT_AUTHOR_EMAIL: "reaper-tests@example.com", GIT_COMMITTER_NAME: "Reaper Tests", GIT_COMMITTER_EMAIL: "reaper-tests@example.com" } }, (error) => (error ? reject(error) : resolve()));
      }),
    );

    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(sandboxB.worktreePath, "src", "b.ts"), "export const b = 2;\n", "utf8"));
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", sandboxB.worktreePath, "add", "."], (error) => (error ? reject(error) : resolve()));
      }),
    );
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", sandboxB.worktreePath, "commit", "-m", "task b"], { env: { ...process.env, GIT_AUTHOR_NAME: "Reaper Tests", GIT_AUTHOR_EMAIL: "reaper-tests@example.com", GIT_COMMITTER_NAME: "Reaper Tests", GIT_COMMITTER_EMAIL: "reaper-tests@example.com" } }, (error) => (error ? reject(error) : resolve()));
      }),
    );

    const merged = await runIntegratorMerge(workspaceRoot, [sandboxA.branchName, sandboxB.branchName]);
    assert.equal(merged.ok, true);
    const mainA = await readFile(path.join(workspaceRoot, "src", "a.ts"), "utf8");
    const mainB = await readFile(path.join(workspaceRoot, "src", "b.ts"), "utf8");
    assert.match(mainA, /a = 1/);
    assert.match(mainB, /b = 2/);
  } finally {
    await cleanupSandboxWorkspace(workspaceRoot, sandboxA).catch(() => undefined);
    await cleanupSandboxWorkspace(workspaceRoot, sandboxB).catch(() => undefined);
  }
});

test("delegated plan failure propagates back without poisoning completed subtasks", async () => {
  const workspaceRoot = await createTempWorkspace();
  const plan = [
    { id: "one", title: "One", prompt: "Write src/one.ts", verificationCommand: "node -e \"process.exit(0)\"", dependsOn: [], files: ["src/one.ts"] },
    { id: "two", title: "Two", prompt: "Fail verification", verificationCommand: "node -e \"process.exit(1)\"", dependsOn: [], files: ["src/two.ts"] },
  ];
  const fileLeases = allocateFileLeases(plan);
  const toolCallsBySubtask: Record<string, ToolCall[]> = {
    one: [{ id: "1", name: "write_file", args: { path: "src/one.ts", content: "export const one = true;\n" } }],
    two: [{ id: "1", name: "write_file", args: { path: "src/two.ts", content: "export const two = true;\n" } }],
  };

  const result = await runDelegatedPlan({
    workspaceRoot,
    config: createValidConfig(),
    sessionId: "session-1",
    prompt: "Run delegated tasks",
    plan,
    fileLeases,
    toolCallsBySubtask,
  });

  assert.equal(result.ok, false);
  assert.ok(result.completedSubtasks.includes("one"));
  assert.ok(result.failedSubtasks.some((item) => item.id === "two"));
  const file = await readFile(path.join(workspaceRoot, "src", "one.ts"), "utf8");
  assert.match(file, /one = true/);
});

test("runtime engine executes delegate_to_plan orchestration requests", { skip: true }, async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Delegate work across two files",
    tool_calls: [
      {
        id: "delegate",
        name: "delegate_to_plan",
        args: {
          plan: [
            { id: "one", title: "One", prompt: "Create a.ts", verificationCommand: "node -e \"process.exit(0)\"", files: ["src/a.ts"] },
            { id: "two", title: "Two", prompt: "Create b.ts", verificationCommand: "node -e \"process.exit(0)\"", files: ["src/b.ts"], dependsOn: ["one"] },
          ],
        },
      },
    ],
    tool_calls_by_subtask: {
      one: [{ id: "1", name: "write_file", args: { path: "src/a.ts", content: "export const a = true;\n" } }],
      two: [{ id: "1", name: "write_file", args: { path: "src/b.ts", content: "export const b = true;\n" } }],
    },
  };

  const result = await new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request }).run();

  const a = await readFile(path.join(workspaceRoot, "src", "a.ts"), "utf8");
  const b = await readFile(path.join(workspaceRoot, "src", "b.ts"), "utf8");
  assert.match(a, /a = true/);
  assert.match(b, /b = true/);
});
