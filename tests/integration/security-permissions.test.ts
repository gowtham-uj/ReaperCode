import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

async function createExecutor(
  workspaceRoot: string,
  permissionMode: "yolo" | "accept_edits" | "auto" | "strict" = "yolo",
) {
  return new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    permissionMode,
  });
}

// ---------------------------------------------------------------------------
// Hard-deny + local-deny in yolo
// ---------------------------------------------------------------------------

test("hard-deny command rules block in yolo", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "yolo");
  const result = await executor.execute({
    id: "rm-root",
    name: "bash",
    args: { cmd: "rm -rf /", timeout: 60 },
  });
  assert.equal(result.ok, false, "hard deny must block rm -rf /");
  assert.equal(result.error?.code, "permission_denied");
});

test("explicit rules.local.md deny blocks in yolo", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "rules.local.md"), "- deny: rm\\s+-rf\\s+/workspace\n", "utf8");
  const executor = await createExecutor(workspaceRoot, "yolo");
  const result = await executor.execute({
    id: "deny-local",
    name: "bash",
    args: { cmd: "rm -rf /workspace", timeout: 60 },
  });
  assert.equal(result.ok, false, "explicit local deny must block");
  assert.equal(result.error?.code, "permission_denied");
});

test("ordinary trusted commands still run in yolo", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "yolo");
  const result = await executor.execute({
    id: "echo",
    name: "bash",
    args: { cmd: "node -e \"console.log('hello-world')\"", timeout: 60 },
  });
  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /hello-world/);
});

// ---------------------------------------------------------------------------
// accept_edits: safe reads/writes succeed, higher-risk operations surface
// approval_required.
// ---------------------------------------------------------------------------

test("accept_edits allows safe reads", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "accept_edits");
  const result = await executor.execute({
    id: "read",
    name: "read_file",
    args: { path: "README.md" },
  });
  assert.equal(result.ok, true);
});

test("accept_edits allows safe shell commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "accept_edits");
  const result = await executor.execute({
    id: "cat",
    name: "bash",
    args: { cmd: "cat README.md | head -3", timeout: 60 },
  });
  assert.equal(result.ok, true);
});

test("accept_edits denies hard-deny shell commands (rm -rf /)", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "accept_edits");
  const result = await executor.execute({
    id: "rm",
    name: "bash",
    args: { cmd: "rm -rf /", timeout: 60 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "permission_denied");
});

// ---------------------------------------------------------------------------
// auto/strict: fail closed for unapproved operations.
// ---------------------------------------------------------------------------

test("strict mode returns approval_required for high-risk bash commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot, "strict");
  const result = await executor.execute({
    id: "curl",
    name: "bash",
    args: { cmd: "curl https://example.com", timeout: 60 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error?.code ?? "", /approval_required|permission_denied/);
});

// ---------------------------------------------------------------------------
// PreToolUse hook enforcement
// ---------------------------------------------------------------------------

test("PreToolUse hook allow:false blocks the dispatch and the side effect does not occur", async () => {
  const workspaceRoot = await createTempWorkspace();
  const targetPath = path.join(workspaceRoot, "hook-blocked.txt");

  const blockedHook = {
    emit: async (event: { name: string; payload: unknown; blockable: boolean }) => {
      if (event.name === "PreToolUse") {
        return { allow: false, reason: "blocked by test hook" };
      }
      return { allow: true };
    },
  };

  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    permissionMode: "yolo",
    hooks: blockedHook as never,
  });

  const result = await executor.execute({
    id: "write-blocked",
    name: "write_file",
    args: { path: "hook-blocked.txt", content: "should not exist" },
  });

  assert.equal(result.ok, false, "PreToolUse allow:false must block");
  assert.equal(result.error?.code, "hook_blocked");

  let exists = false;
  try {
    const { stat } = await import("node:fs/promises");
    await stat(targetPath);
    exists = true;
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "hook must block the side effect, not just the result");
});

test("PreToolUse hook engine exception remains non-blocking (existing policy)", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    permissionMode: "yolo",
    hooks: {
      emit: async () => {
        throw new Error("hook engine exploded");
      },
    } as never,
  });

  const result = await executor.execute({
    id: "echo",
    name: "bash",
    args: { cmd: "node -e \"console.log('survived')\"", timeout: 60 },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /survived/);
});

// ---------------------------------------------------------------------------
// Error code stability
// ---------------------------------------------------------------------------

test("distinct denial categories produce stable error codes", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "ok.ts"), "export const x = 1;\n", "utf8");

  const executor = await createExecutor(workspaceRoot, "yolo");

  const esc = await executor.execute({
    id: "esc",
    name: "read_file",
    args: { path: "../outside.txt" },
  });
  assert.equal(esc.ok, false);
  assert.equal(esc.error?.code, "path_escape");

  const hd = await executor.execute({
    id: "hd",
    name: "bash",
    args: { cmd: "rm -rf /", timeout: 60 },
  });
  assert.equal(hd.ok, false);
  assert.equal(hd.error?.code, "permission_denied");

  const ut = await executor.execute({
    id: "ut",
    name: "not_a_real_tool",
    args: {},
  } as never);
  assert.equal(ut.ok, false);
  assert.match(ut.error?.code ?? "", /UNKNOWN_TOOL/);

  const ip = await executor.execute({
    id: "ip",
    name: "read_file",
    args: { path: 42 },
  } as never);
  assert.equal(ip.ok, false);
  assert.equal(ip.error?.code, "INVALID_TOOL_PARAMS");
});