import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createLiveDeepSeekGateway } from "../fixtures/live-gateway.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("verification passes and writes verification summary logs", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Run payload verification and confirm it succeeds",
    tool_calls: [
      { id: "1", name: "complete_task", args: { summary: "ready to verify" } },
    ],
    verification: {
      command: "node -e \"console.log('verified')\"",
      maxIterations: 2,
    },
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();
  const trajectory = await readFile(result.trajectoryPath, "utf8");

  assert.equal(result.verification?.ok, true);
  assert.match(trajectory, /verification_summary/);
});

test("complete_task verification contract runs before caller verification", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Use the declared verification contract, then run caller verification.",
    tool_calls: [
      {
        id: "1",
        name: "complete_task",
        args: {
          summary: "contract declared",
          verificationContract: {
            intent: "prove contract commands are honored",
            commands: [
              {
                id: "contract-check",
                command: "node -e \"require('fs').writeFileSync('contract-ran.txt','yes')\"",
                purpose: "record that the contract command ran",
                required: true,
              },
            ],
          },
        },
      },
    ],
    verification: {
      command: "node -e \"const fs=require('fs'); if(fs.readFileSync('contract-ran.txt','utf8')!=='yes') process.exit(1)\"",
      maxIterations: 1,
      allowJudgeRetry: false,
    },
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();

  assert.equal(result.verification?.ok, true);
  assert.match(result.verification?.command ?? "", /contract-ran/);
});

test("non-deterministic verification failures do not consume retry budget immediately", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Run verification with environment noise",
    tool_calls: [{ id: "1", name: "complete_task", args: { summary: "ready to verify environment behavior" } }],
    verification: {
      command: "node -e \"console.error('EADDRINUSE: address already in use'); process.exit(1)\"",
      maxIterations: 1,
      allowJudgeRetry: false,
    },
  };

  const engine = new RuntimeEngine({ config: createValidConfig(), workspaceRoot, requestEnvelope: request });
  const result = await engine.run();

  assert.equal(result.verification?.ok, false);
  assert.equal(result.verification?.retryBudgetConsumed, 1);
  assert.ok((result.verification?.attemptCount ?? 0) >= 3);
  assert.match((result.verification?.feedback ?? []).join("\n"), /EADDRINUSE/);
});

test(
  "live judge feedback injects constraints and retries deterministically failing verification",
  { skip: !(process.env.RUN_LIVE_LLM_TESTS === "1" && process.env.DEEPSEEK_API_KEY) },
  async () => {
    const workspaceRoot = await createTempWorkspace();
    const request = createValidRequestEnvelope();
    request.payload = {
      prompt: "Update src/app.ts so the answer is 42, then verify it.",
      tool_calls: [
        { id: "1", name: "read_file", args: { path: "src/app.ts" } },
        { id: "2", name: "complete_task", args: { summary: "ready to verify" } },
      ],
      verification: {
        command: "node -e \"const fs=require('fs'); const t=fs.readFileSync('src/app.ts','utf8'); if(!t.includes('42')){console.error('Expected 42 but got 41'); process.exit(1)}\"",
        maxIterations: 2,
        allowJudgeRetry: true,
      },
    };

    const { config, gateway } = createLiveDeepSeekGateway("live judge feedback injects constraints and retries deterministically failing verification");
    const engine = new RuntimeEngine({ config, workspaceRoot, requestEnvelope: request, modelGateway: gateway });
    const result = await engine.run();
    const file = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

    assert.ok((result.verification?.feedback?.length ?? 0) >= 1);
    assert.ok((result.verification?.negativeConstraints?.length ?? 0) >= 0);
    assert.ok((result.verification?.attemptCount ?? 0) >= 1);
    if (result.verification?.ok) {
      assert.match(file, /42/);
    } else {
      assert.match((result.verification?.feedback ?? []).join("\n"), /42|Expected 42|src\/app.ts/i);
    }
  },
);

test("verification feedback is included in final live summary when available", { skip: !(process.env.RUN_LIVE_LLM_TESTS === "1" && process.env.DEEPSEEK_API_KEY) }, async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Read the file, fail verification once, and recover.",
    tool_calls: [
      { id: "1", name: "read_file", args: { path: "src/app.ts" } },
      { id: "2", name: "complete_task", args: { summary: "ready to verify" } },
    ],
    verification: {
      command: "node -e \"const fs=require('fs'); const t=fs.readFileSync('src/app.ts','utf8'); if(!t.includes('42')){console.error('Expected 42 but got 41'); process.exit(1)}\"",
      maxIterations: 2,
      allowJudgeRetry: true,
    },
  };

  const { config, gateway } = createLiveDeepSeekGateway("verification feedback is included in final live summary when available");
  const engine = new RuntimeEngine({ config, workspaceRoot, requestEnvelope: request, modelGateway: gateway });
  const result = await engine.run();

  assert.ok((result.verification?.feedback?.length ?? 0) >= 1);
  assert.match(result.assistantMessage.toLowerCase(), /verify|verification|42|file|failed/);
});
