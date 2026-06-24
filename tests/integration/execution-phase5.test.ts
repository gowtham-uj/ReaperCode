import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("non-barrier shell commands see staged WAL content before final flush", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Stage a write and inspect it without flushing first",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
      { id: "2", name: "run_shell_command", args: { cmd: "node -e \"const fs=require('fs'); process.stdout.write(fs.readFileSync('src/app.ts','utf8'))\"" } },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const shellOutput = result.toolResults.find((item) => item.name === "run_shell_command")?.output as { stdout: string };
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.match(shellOutput.stdout, /42/);
  assert.match(disk, /42/);
});

test("barrier-flushed writes survive later batch failures", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Use a barrier command and then fail later",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
      {
        id: "2",
        name: "run_shell_command",
        args: {
          cmd: "node -e \"const fs=require('fs'); process.stdout.write(fs.readFileSync('src/app.ts','utf8'))\"",
          barrier: true,
        },
      },
      { id: "3", name: "replace_in_file", args: { path: "src/app.ts", oldString: "does-not-exist", newString: "99" } },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const shellOutput = result.toolResults.find((item) => item.toolCallId === "2")?.output as { stdout: string };
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.match(shellOutput.stdout, /42/);
  assert.equal(result.toolResults.find((item) => item.toolCallId === "1")?.ok, true);
  assert.equal(result.toolResults.find((item) => item.toolCallId === "3")?.ok, false);
  assert.match(disk, /42/);
});

test("build-style commands are auto-promoted to barrier mode", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Use npm version while staged write exists",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
      { id: "2", name: "run_shell_command", args: { cmd: "npm --version" } },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const shellOutput = result.toolResults.find((item) => item.toolCallId === "2")?.output as { stdout: string };
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.equal(result.toolResults.find((item) => item.toolCallId === "2")?.ok, true);
  assert.match(shellOutput.stdout, /\d+/);
  assert.match(disk, /42/);
});

test("concurrent non-barrier pool returns results in completion order", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Run two independent non-barrier commands concurrently",
    tool_calls: [
      {
        id: "slow",
        name: "run_shell_command",
        args: {
          cmd: "node -e \"const fs=require('fs'); const start=Date.now(); const tick=()=>{ if (fs.existsSync('fast.marker') || Date.now()-start>5000) setTimeout(()=>console.log('slow'),250); else setTimeout(tick,25); }; tick();\"",
          forceNonBarrier: true,
        },
      },
      {
        id: "fast",
        name: "run_shell_command",
        args: {
          cmd: "node -e \"require('fs').writeFileSync('fast.marker','1'); console.log('fast')\"",
          forceNonBarrier: true,
        },
      },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const completed = result.events
    .filter((event) => event.message_type === "tool_call_completed")
    .map((event) => ({
      toolCallId: (event.payload as { result?: { toolCallId?: string } }).result?.toolCallId,
    }));

  assert.equal(completed[0]?.toolCallId, "fast");
  assert.equal(completed[1]?.toolCallId, "slow");
});

test("runtime blocks shell-created empty source placeholders", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Try to create empty source placeholders",
    tool_calls: [
      { id: "1", name: "run_shell_command", args: { cmd: ": > src/db.ts && touch src/types.ts" } },
    ],
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const blocked = result.toolResults.find((item) => item.toolCallId === "1");

  assert.equal(blocked?.ok, false);
  assert.equal(blocked?.error?.code, "source_empty_placeholder_shell_blocked");
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
