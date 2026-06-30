import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCheckpoint, restoreCheckpoint } from "../../src/runtime/checkpoints.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("restore checkpoint reverts controlled tracked and untracked mutations", async () => {
  const workspaceRoot = await createTempWorkspace();
  await ignoreReaperState(workspaceRoot);
  const checkpoint = await createCheckpoint({
    workspaceRoot,
    reason: "integration restore",
    toolCallIds: ["mutate-1"],
  });

  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 500;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "src", "generated.ts"), "export const generated = true;\n", "utf8");

  const restored = await restoreCheckpoint(workspaceRoot, checkpoint.id);
  const app = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.equal(restored.restored, true);
  assert.match(app, /answer = 41/);
  assert.doesNotMatch(restored.statusAfterRestore, /src\/generated.ts/);
});

test("runtime appends checkpoint and git state results after mutating batches only", async () => {
  const workspaceRoot = await createTempWorkspace();
  await ignoreReaperState(workspaceRoot);
  const mutatingRequest = createValidRequestEnvelope();
  mutatingRequest.payload = {
    prompt: "Mutate a tracked file",
    tool_calls: [
      { id: "mutate-1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
    ],
  };

  const mutatingResult = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: mutatingRequest,
  }).run();

  assert.equal(mutatingResult.toolResults[0]?.name, "replace_in_file");
  assert.ok(mutatingResult.toolResults.some((result) => result.name === "create_checkpoint" && result.ok));
  assert.ok(mutatingResult.toolResults.some((result) => result.name === "git_status" && result.ok));
  assert.ok(mutatingResult.toolResults.some((result) => result.name === "git_diff" && result.ok));

  const readOnlyRequest = createValidRequestEnvelope();
  readOnlyRequest.payload = {
    prompt: "Read a tracked file",
    tool_calls: [
      { id: "read-1", name: "read_file", args: { path: "src/app.ts" } },
    ],
  };
  const readOnlyResult = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: readOnlyRequest,
  }).run();

  assert.equal(readOnlyResult.toolResults.some((result) => result.name === "create_checkpoint"), false);
});

async function ignoreReaperState(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, ".gitignore"), ".reaper/\n", "utf8");
  await run("git", ["add", ".gitignore"], workspaceRoot);
  await run("git", ["commit", "-m", "Ignore Reaper state"], workspaceRoot);
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
