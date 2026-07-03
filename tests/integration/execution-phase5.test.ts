import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("tool_calls execute in order and a shell command sees the file written by an earlier call", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Write a file then read it back with bash",
    tool_calls: [
      { id: "1", name: "write_file", args: { path: "src/app.ts", content: "export const answer = 42;\n" } },
      {
        id: "2",
        name: "bash",
        args: {
          cmd: "node -e \"const fs=require('fs'); process.stdout.write(fs.readFileSync('src/app.ts','utf8'))\"",
          timeout: 60,
        },
      },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const shellOutput = result.toolResults.find((item) => item.toolCallId === "2")?.output as { stdout?: string };
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.equal(result.toolResults.find((item) => item.toolCallId === "1")?.ok, true);
  assert.equal(result.toolResults.find((item) => item.toolCallId === "2")?.ok, true);
  assert.match(shellOutput?.stdout ?? "", /42/);
  assert.match(disk, /42/);
});

test("when one tool call fails and another succeeds, the successful write persists on disk", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Make a valid write and a failing write; the valid one should survive",
    tool_calls: [
      { id: "1", name: "write_file", args: { path: "src/valid.ts", content: "export const persisted = true;\n" } },
      {
        id: "2",
        name: "bash",
        args: {
          // writing into a nonexistent directory fails (non-barrier shell)
          cmd: "printf 'x' > nope/missing-dir/file.txt",
          timeout: 60,
        },
      },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const disk = await readFile(path.join(workspaceRoot, "src", "valid.ts"), "utf8");

  assert.equal(result.toolResults.find((item) => item.toolCallId === "1")?.ok, true);
  assert.equal(result.toolResults.find((item) => item.toolCallId === "2")?.ok, false);
  assert.match(disk, /persisted/);
});

test("shell command that creates empty source placeholders succeeds (no synthetic block)", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Try to create empty source placeholders via shell",
    tool_calls: [
      {
        id: "1",
        name: "bash",
        args: {
          cmd: ": > src/db.ts && touch src/types.ts",
          timeout: 60,
        },
      },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const shellResult = result.toolResults.find((item) => item.toolCallId === "1");

  // The guard that used to block this (source_empty_placeholder_shell_blocked)
  // was removed. The model gets the real shell result: the command succeeds.
  assert.equal(shellResult?.ok, true);
  assert.notEqual(shellResult?.error?.code, "source_empty_placeholder_shell_blocked");
  await access(path.join(workspaceRoot, "src", "db.ts"));
  await access(path.join(workspaceRoot, "src", "types.ts"));
});

test("allocated scratch workspaces allow full writes over empty generated source files", async () => {
  const workspaceRoot = await createAllocatedScratchWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "db.ts"), "", "utf8");
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Fill an empty generated source file",
    tool_calls: [
      { id: "1", name: "write_file", args: { path: "src/db.ts", content: "export const dbReady = true;\n" } },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const disk = await readFile(path.join(workspaceRoot, "src", "db.ts"), "utf8");

  assert.equal(result.toolResults.find((item) => item.toolCallId === "1")?.ok, true);
  assert.match(disk, /dbReady/);
});

async function createAllocatedScratchWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-test-"));
  const workspaceRoot = path.join(root, "reaper_eval", "workspaces", "initial-task-1", "run-1");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# Scratch Workspace\n", "utf8");
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }, null, 2), "utf8");
  await run("git", ["init"], workspaceRoot);
  await run("git", ["add", "."], workspaceRoot);
  await run("git", ["commit", "-m", "Initial fixture"], workspaceRoot);
  return workspaceRoot;
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Reaper Tests",
          GIT_AUTHOR_EMAIL: "reaper-tests@example.com",
          GIT_COMMITTER_NAME: "Reaper Tests",
          GIT_COMMITTER_EMAIL: "reaper-tests@example.com",
        },
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      },
    );
  });
}
