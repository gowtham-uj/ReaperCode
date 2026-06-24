import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
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
} from "../../src/model/types.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createLiveDeepSeekGateway } from "../fixtures/live-gateway.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

const AUTO_APPENDED_TOOL_NAMES = new Set(["create_checkpoint", "git_status", "git_diff"]);

type ToolResultLike = { name?: string; ok?: boolean };

function requestedToolResults<T extends ToolResultLike>(results: T[]): T[] {
  return results.filter((result) => !result.name || !AUTO_APPENDED_TOOL_NAMES.has(result.name));
}

test("runtime engine executes real tool calls and writes trajectory logs", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Inspect and update the workspace",
    tool_calls: [
      { id: "1", name: "read_file", args: { path: "src/app.ts" } },
      { id: "2", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
      { id: "3", name: "run_shell_command", args: { cmd: "node -e \"console.log('verify-ok')\"" } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  const requestedResults = requestedToolResults(result.toolResults);
  assert.equal(requestedResults.length, 3);
  assert.equal(requestedResults.every((item) => item.ok), true);
  const app = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(app, /42/);
  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /session_start/);
  assert.match(trajectory, /tool_call/);
  assert.match(trajectory, /session_metrics/);
  assert.match(result.assistantMessage, /Executed \d+ tool call/);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
});

test("runtime engine creates isolated run-local artifacts for placeholder trace ids", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Inspect workspace",
    tool_calls: [{ id: "1", name: "run_shell_command", args: { cmd: "printf isolated-run" } }],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.match(result.state.runId, /^run-\d{14}-[a-f0-9]{8}$/);
  assert.notEqual(result.state.runId, "trace-1");
  assert.match(result.trajectoryPath, new RegExp(`\\.reaper/runs/${result.state.runId}/logs/reaper-trajectory\\.jsonl$`));

  const runResult = JSON.parse(await readFile(path.join(workspaceRoot, ".reaper", "runs", result.state.runId, "result.json"), "utf8")) as {
    status: string;
    toolResultCount: number;
  };
  assert.equal(runResult.status, "completed");
  assert.equal(requestedToolResults(result.toolResults).length, 1);

  const latest = JSON.parse(await readFile(path.join(workspaceRoot, ".reaper", "latest-run.json"), "utf8")) as { runId: string };
  assert.equal(latest.runId, result.state.runId);
});

test("runtime engine surfaces failed tools cleanly", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Fail on shell command error",
    tool_calls: [
      { id: "1", name: "run_shell_command", args: { cmd: "node -e \"process.exit(2)\"", timeoutMs: 20 } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.equal(result.toolResults[0]?.ok, false);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
  assert.match(result.assistantMessage, /1 failed/);
});

test("runtime engine waits for complete_task before explicit verification", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Write the answer and verify it",
    tool_calls: [{ id: "1", name: "write_file", args: { path: "answer.txt", content: "ok\n" } }],
    verification: {
      command: "test \"$(cat answer.txt)\" = ok",
      maxIterations: 1,
      allowJudgeRetry: false,
    },
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.equal(result.verification, undefined);
});

test("runtime engine fails gracefully when no live model is configured for autonomous solving", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Inspect the codebase, decide what to change, and fix the bug.",
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.equal(result.toolResults.length, 0);
  assert.equal(result.events.some((event) => event.message_type === "error"), true);
  assert.match(result.assistantMessage, /requires a live LLM provider/i);
});

test("autonomous runtime executes simple tasks directly without planner subagent", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create simple.txt and verify it.",
  };
  const gateway = new StaticJsonGateway({
    assistant_message: "Executing simple task directly.",
    tool_calls: [
      { id: "write-simple", name: "write_file", args: { path: "simple.txt", content: "simple-ok\n" } },
      { id: "verify-simple", name: "run_shell_command", args: { cmd: "test \"$(cat simple.txt)\" = simple-ok" } },
      {
        id: "complete-simple",
        name: "complete_task",
        args: {
          summary: "simple.txt was created and verified",
          verificationContract: { commands: [{ command: "test \"$(cat simple.txt)\" = simple-ok", required: true }] },
        },
      },
    ],
  });

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 2);
  assert.equal(requestedToolResults(result.toolResults).length, 2);
  assert.equal(requestedToolResults(result.toolResults).every((item) => item.ok), true);
  assert.equal(result.verification?.ok, true);
  assert.equal(await readFile(path.join(workspaceRoot, "simple.txt"), "utf8"), "simple-ok\n");
});

test("autonomous runtime allows completion after python verification fixes earlier python failure", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Repair system python pip and verify it.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Reproducing pip failure.",
      tool_calls: [
        {
          id: "pip-fails",
          name: "run_shell_command",
          args: { cmd: "python3 -c \"import sys; sys.stderr.write('No module named pip\\n'); sys.exit(1)\"" },
        },
      ],
    },
    {
      assistant_message: "Pip repair verified.",
      tool_calls: [
        { id: "pip-fixed", name: "run_shell_command", args: { cmd: "python3 -c \"import pip; print(pip.__version__)\"" } },
        { id: "complete-pip", name: "complete_task", args: { summary: "pip was repaired and verified" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  const requested = requestedToolResults(result.toolResults);
  assert.equal(gateway.generateCount, 3);
  assert.equal(requested.length, 2);
  assert.equal(requested[0]?.ok, false);
  assert.equal(requested[1]?.ok, true);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
  assert.equal(result.assistantMessage, "pip was repaired and verified");
});

test("missing-artifact validation guard allows same-batch producers before verification", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create docker-compose.yml and .dockerignore, then verify both files exist.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Reproduce missing artifact first.",
      tool_calls: [
        {
          id: "missing-docker-files",
          name: "run_shell_command",
          args: { cmd: "ls -la docker-compose.yml .dockerignore" },
        },
      ],
    },
    {
      assistant_message: "Create and verify in one batch.",
      tool_calls: [
        { id: "write-compose", name: "write_file", args: { path: "docker-compose.yml", content: "services:\n  app:\n    image: node:20\n" } },
        { id: "write-ignore", name: "write_file", args: { path: ".dockerignore", content: "node_modules\n.reaper\n" } },
        {
          id: "verify-docker-files",
          name: "run_shell_command",
          args: { cmd: "test -s docker-compose.yml && test -s .dockerignore && grep -q services docker-compose.yml && grep -q node_modules .dockerignore" },
        },
        { id: "complete-docker-files", name: "complete_task", args: { summary: "Docker files created and verified" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(result.toolResults.some((item) => item.error?.code === "missing_artifact_validation_blocked"), false);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "verify-docker-files" && item.ok), true);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
});

test("autonomous runtime requires grounded verification before completion when gate is enabled", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create gated.txt and complete only after grounded verification.",
  };
  const config = createValidConfig();
  config.verification.requireGroundedCompletion = true;
  config.verification.selfDebugExplanation.enabled = false;
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Trying to finish without evidence.",
      tool_calls: [{ id: "early-complete", name: "complete_task", args: { summary: "gated.txt created" } }],
    },
    {
      assistant_message: "Creating and verifying.",
      tool_calls: [
        { id: "write-gated", name: "write_file", args: { path: "gated.txt", content: "ok\n" } },
        { id: "verify-gated", name: "run_shell_command", args: { cmd: "test \"$(cat gated.txt)\" = ok" } },
        { id: "complete-gated", name: "complete_task", args: { summary: "gated.txt created" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 3);
  assert.equal(result.verification?.ok, true);
  assert.equal(result.verification?.groundedSignal?.kind, "artifact_check");
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  const auditPath = path.join(workspaceRoot, ".reaper", "runs", result.state.runId, "logs", "reaper-audit.jsonl");
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /verification_gate/);
});

test("autonomous runtime best-of-N mirrors the verified rollout over self-report", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create bon.txt and verify it.",
  };
  const config = createValidConfig();
  config.runtime.voteAttempts = 2;
  config.verification.selfDebugExplanation.enabled = false;
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Verify bon.txt content.",
      steps: [
        {
          id: "self-report",
          title: "Self-report",
          instructions: "Incorrectly finish without evidence.",
          tool_calls: [{ id: "self-report", name: "complete_task", args: { summary: "bon.txt created" } }],
        },
      ],
    },
    {
      installs: [],
      testGuidance: "Verify bon.txt content.",
      steps: [
        {
          id: "verified",
          title: "Create and verify",
          instructions: "Create bon.txt and verify its content.",
          tool_calls: [
            { id: "write-bon", name: "write_file", args: { path: "bon.txt", content: "verified\n" } },
            { id: "verify-bon", name: "run_shell_command", args: { cmd: "test \"$(cat bon.txt)\" = verified" } },
            {
              id: "complete-bon",
              name: "complete_task",
              args: {
                summary: "bon.txt created and verified",
                verificationContract: { commands: [{ command: "test \"$(cat bon.txt)\" = verified", required: true }] },
              },
            },
          ],
        },
      ],
    },
  ]);

  const result = await new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  assert.ok(gateway.generateCount >= 2);
  assert.equal(result.verification?.ok, true);
  assert.equal(result.assistantMessage, "bon.txt created and verified");
  assert.equal(await readFile(path.join(workspaceRoot, "bon.txt"), "utf8"), "verified\n");
});

test("autonomous runtime emits no_progress_detected and stops after repeated unchanged action", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Run a simple repeated diagnostic until Reaper detects no progress.",
  };
  const config = createValidConfig();
  config.runtime.progressGuard.stallSteps = 1;
  const gateway = new StaticJsonGateway({
    assistant_message: "",
    tool_calls: [{ id: "same-diagnostic", name: "run_shell_command", args: { cmd: "node -e \"console.log('same-observation')\"" } }],
  });

  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(result.toolResults.some((item) => item.error?.code === "no_progress_loop_blocked"), true);
  assert.match(result.assistantMessage, /stuck|no progress|completion gate/i);
  const auditPath = path.join(workspaceRoot, ".reaper", "runs", result.state.runId, "logs", "reaper-audit.jsonl");
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /no_progress_detected/);
});

test("autonomous runtime caps completion gate attempts and emits completion_gate_exhausted", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: exercise the completion gate cap without doing extra work.",
  };
  const config = createValidConfig();
  config.runtime.completionGateMax = 2;
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      steps: [
        {
          id: "finalize-only",
          title: "Finalize only",
          type: "finalize",
          instructions: "Ask the completion gate to decide whether to finish.",
          successCriteria: ["The completion gate must stop after its configured cap."],
          tool_calls: [],
        },
      ],
      testGuidance: "No external checks required for this fixture.",
    },
    { assistant_message: "", tool_calls: [] },
  ]);

  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 2);
  assert.match(result.assistantMessage, /completion gate exhausted 2 attempt/i);
  const metricsPath = path.join(workspaceRoot, ".reaper", "runs", result.state.runId, "trajectory-metrics.json");
  const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as { completion_gate_attempts: number; stop_reason: string };
  assert.equal(metrics.completion_gate_attempts, 2);
  assert.equal(metrics.stop_reason, "gate_exhausted");
});

test("autonomous runtime plans once and drains durable execution steps", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create answer.txt and verify it.",
  };
  const gateway = new StaticJsonGateway({
    installs: [],
    testGuidance: "Run npm test or relevant local checks.",
    steps: [
      {
        id: "write-answer",
        title: "Write answer",
        instructions: "Create the requested file.",
        tool_calls: [{ id: "write-answer-file", name: "write_file", args: { path: "answer.txt", content: "ok\n" } }],
      },
      {
        id: "verify-answer",
        title: "Verify answer",
        instructions: "Run local verification and complete.",
        tool_calls: [
          { id: "verify-answer-command", name: "run_shell_command", args: { cmd: "test \"$(cat answer.txt)\" = ok" } },
          {
            id: "complete-answer",
            name: "complete_task",
            args: {
              summary: "answer.txt was created and verified",
              verificationContract: { commands: [{ command: "test \"$(cat answer.txt)\" = ok", required: true }] },
            },
          },
        ],
      },
    ],
  });

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 2);
  const durableRequested = requestedToolResults(result.toolResults);
  assert.equal(durableRequested.length, 2);
  assert.equal(durableRequested.every((item) => item.ok), true);
  assert.equal(result.verification?.ok, true);
  assert.equal(await readFile(path.join(workspaceRoot, "answer.txt"), "utf8"), "ok\n");
});

test("autonomous runtime can generate tool calls for a durable step without initial tool calls", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create deferred.txt and verify it.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Run local verification.",
      steps: [
        {
          id: "deferred-step",
          title: "Create deferred file",
          instructions: "Create deferred.txt and verify it.",
        },
      ],
    },
    {
      assistant_message: "Executing deferred step.",
      tool_calls: [
        { id: "write-deferred", name: "write_file", args: { path: "deferred.txt", content: "deferred-ok\n" } },
        { id: "verify-deferred", name: "run_shell_command", args: { cmd: "test \"$(cat deferred.txt)\" = deferred-ok" } },
        {
          id: "complete-deferred",
          name: "complete_task",
          args: {
            summary: "deferred.txt was created and verified",
            verificationContract: { commands: [{ command: "test \"$(cat deferred.txt)\" = deferred-ok", required: true }] },
          },
        },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount >= 2);
  const deferredRequested = requestedToolResults(result.toolResults);
  assert.equal(deferredRequested.length, 2);
  assert.equal(deferredRequested.every((item) => item.ok), true);
  assert.equal(result.verification?.ok, true);
  assert.equal(await readFile(path.join(workspaceRoot, "deferred.txt"), "utf8"), "deferred-ok\n");
});

test("autonomous runtime treats mid-plan verification as checkpoint, not completion", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create two files with a checkpoint between them.",
  };
  const gateway = new StaticJsonGateway({
    installs: [],
    testGuidance: "Run checkpoint and final tests.",
    steps: [
      {
        id: "write-first",
        title: "Write first file",
        instructions: "Create the first file.",
        tool_calls: [{ id: "write-first-file", name: "write_file", args: { path: "first.txt", content: "ok\n" } }],
      },
      {
        id: "checkpoint-first",
        title: "Checkpoint first file",
        instructions: "Verify the first file before continuing.",
        tool_calls: [
          {
            id: "write-checkpoint-test",
            name: "write_file",
            args: {
              path: "tests/checkpoint.test.mjs",
              content:
                "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\ntest('first file exists', () => {\n  assert.equal(readFileSync('first.txt', 'utf8'), 'ok\\n');\n});\n",
            },
          },
          { id: "checkpoint-first-command", name: "run_shell_command", args: { cmd: "node --test tests/checkpoint.test.mjs" } },
        ],
      },
      {
        id: "write-second",
        title: "Write second file",
        instructions: "Continue after checkpoint passes.",
        tool_calls: [{ id: "write-second-file", name: "write_file", args: { path: "second.txt", content: "done\n" } }],
      },
      {
        id: "final-verify",
        title: "Final verification",
        instructions: "Verify all requested artifacts and complete.",
        tool_calls: [
          {
            id: "write-final-test",
            name: "write_file",
            args: {
              path: "tests/final.test.mjs",
              content:
                "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\ntest('both files exist', () => {\n  assert.equal(readFileSync('first.txt', 'utf8'), 'ok\\n');\n  assert.equal(readFileSync('second.txt', 'utf8'), 'done\\n');\n});\n",
            },
          },
          { id: "final-verify-command", name: "run_shell_command", args: { cmd: "node --test tests/final.test.mjs" } },
          {
            id: "complete-checkpointed-task",
            name: "complete_task",
            args: {
              summary: "Both files were created and verified.",
              verificationContract: {
                commands: [
                  {
                    command: "node --test tests/final.test.mjs",
                    required: true,
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 3);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
  assert.equal(await readFile(path.join(workspaceRoot, "first.txt"), "utf8"), "ok\n");
  assert.equal(await readFile(path.join(workspaceRoot, "second.txt"), "utf8"), "done\n");
});

test("autonomous runtime executes canonical main-agent tool calls", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create alias.txt and verify it.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "",
      tool_calls: [
        { id: "write-alias", name: "write_file", args: { path: "alias.txt", content: "alias-ok\n" } },
        { id: "verify-alias", name: "run_shell_command", args: { cmd: "test \"$(cat alias.txt)\" = alias-ok" } },
        { id: "replace-alias", name: "replace_in_file", args: { path: "alias.txt", oldString: "alias-ok", newString: "alias-replaced" } },
        { id: "write-type-arguments", name: "write_file", args: { path: "alias-2.txt", content: "alias-2-ok\n" } },
        { id: "read-wrapped-filepath", name: "read_file", args: { path: "alias.txt" } },
        { id: "check-alias-2-exists", name: "run_shell_command", args: { cmd: "test -f alias-2.txt" } },
        { id: "check-alias-exists", name: "run_shell_command", args: { cmd: "test -f alias.txt" } },
        { id: "verify-alias-2", name: "run_shell_command", args: { cmd: "test \"$(cat alias-2.txt)\" = alias-2-ok" } },
        { id: "verify-alias-replaced", name: "run_shell_command", args: { cmd: "test \"$(cat alias.txt)\" = alias-replaced" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "finish-alias",
          name: "complete_task",
          args: {
            summary: "alias.txt was created and verified",
            verificationContract: { commands: [{ command: "test \"$(cat alias.txt)\" = alias-replaced", required: true }] },
          },
        },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(result.toolResults.length >= 11);
  assert.equal(requestedToolResults(result.toolResults).length, 9);
  assert.equal(requestedToolResults(result.toolResults).every((item) => item.ok), true);
  assert.equal(await readFile(path.join(workspaceRoot, "alias.txt"), "utf8"), "alias-replaced\n");
  assert.equal(await readFile(path.join(workspaceRoot, "alias-2.txt"), "utf8"), "alias-2-ok\n");
});

test("autonomous runtime ignores tool calls after complete_task in a model batch", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create only before.txt and complete.",
  };
  const gateway = new StaticJsonGateway({
    installs: [],
    testGuidance: "Verify only before file exists.",
    steps: [
      {
        id: "complete-boundary",
        title: "Complete before extra calls",
        instructions: "Calls after complete_task must be ignored.",
	        tool_calls: [
	          { id: "write-before", name: "write_file", args: { path: "before.txt", content: "before\n" } },
	          { id: "verify-before", name: "run_shell_command", args: { cmd: "test \"$(cat before.txt)\" = before" } },
	          { id: "finish", name: "complete_task", args: { summary: "before.txt created" } },
	          { id: "write-after", name: "write_file", args: { path: "after.txt", content: "after\n" } },
	        ],
      },
    ],
  });

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

	  const boundaryRequested = requestedToolResults(result.toolResults);
	  assert.equal(boundaryRequested.length, 2);
	  assert.equal(boundaryRequested[0]?.toolCallId, "write-before");
	  assert.equal(boundaryRequested[1]?.toolCallId, "verify-before");
  assert.equal(await readFile(path.join(workspaceRoot, "before.txt"), "utf8"), "before\n");
  await assert.rejects(() => readFile(path.join(workspaceRoot, "after.txt"), "utf8"));
});

test("autonomous runtime stops when repair repeats the same failed tool pattern", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Try a failing command, then avoid looping on the same repair.",
  };
  const failingCall = { id: "same-fail", name: "run_shell_command", args: { cmd: "node -e \"process.exit(7)\"" } } as const;
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Do not repeat failing command.",
    steps: [
        {
          id: "fail-step",
          title: "Run failing command",
          instructions: "This intentionally fails.",
          tool_calls: [failingCall],
        },
      ],
	    },
	    {
	      assistant_message: "Retrying the same failed command.",
	      tool_calls: [failingCall],
	    },
	  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 3);
  const stuckRequested = requestedToolResults(result.toolResults);
  assert.equal(stuckRequested.length, 3);
  assert.equal(stuckRequested.every((item) => !item.ok), true);
  assert.match(result.assistantMessage, /appears stuck|completion gate exhausted/i);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), false);
});

test("runtime allows same-batch file inspection through the WAL view after state-changing tools", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Write an output file and inspect it.",
    tool_calls: [
      { id: "write-output", name: "write_file", args: { path: "output.txt", content: "ready\n" } },
      { id: "inspect-output", name: "run_shell_command", args: { cmd: "wc -l output.txt && tail -n 1 output.txt", summary: "inspect output file" } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();
  const writeResult = result.toolResults.find((item) => item.toolCallId === "write-output");
  const inspectResult = result.toolResults.find((item) => item.toolCallId === "inspect-output");
  assert.equal(requestedToolResults(result.toolResults).length, 2);
  assert.equal(writeResult?.ok, true);
  assert.equal(inspectResult?.ok, true);
  assert.match(String((inspectResult?.output as { stdout?: string } | undefined)?.stdout ?? ""), /ready/);
  assert.equal(await readFile(path.join(workspaceRoot, "output.txt"), "utf8"), "ready\n");
});

test("runtime blocks mutations to verifier-owned absolute tests path", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Do not edit external verifier harness files.",
    tool_calls: [
      { id: "write-verifier", name: "write_file", args: { path: "/tests/run-tests.sh", content: "echo fake\n" } },
      { id: "shell-verifier", name: "run_shell_command", args: { cmd: "printf fake > /tests/run-tests.sh" } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.equal(result.toolResults.length, 2);
  assert.equal(result.toolResults.every((item) => !item.ok), true);
  assert.equal(result.toolResults[0]?.error?.code, "verifier_owned_path_write_blocked");
  assert.equal(result.toolResults[1]?.error?.code, "verifier_owned_path_write_blocked");
});

test("autonomous runtime completes final output check only after explicit complete_task", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "output.txt"), "ready\n", "utf8");
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: verify output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Read output.txt to verify the required output.",
      steps: [
        {
          id: "finalize",
          title: "Finalize after checking output",
          type: "finalize",
          instructions: "Check output.txt and finish.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [{ id: "check-output", name: "run_shell_command", args: { cmd: "cat output.txt" } }],
    },
    {
      assistant_message: "",
      tool_calls: [{ id: "complete-output", name: "complete_task", args: { summary: "output.txt verified" } }],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(requestedToolResults(result.toolResults).length, 1);
  assert.equal(requestedToolResults(result.toolResults).every((item) => item.ok), true);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.assistantMessage, "output.txt verified");
});

test("autonomous runtime rejects inconsistent stack-trace output counts before completion", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: analyze stack traces and write output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Run the analyzer and inspect output.txt.",
      steps: [
        {
          id: "finalize",
          title: "Analyze stack traces",
          type: "finalize",
          instructions: "Generate output.txt and complete only if the counts are consistent.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "bad-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 285 stack traces\\nNumber of unique call sites (based on top 3 frames): 2503\\nTotal stack traces analyzed: 7406\\n'",
          },
        },
        { id: "bad-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "good-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n'",
          },
        },
        { id: "good-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createSemanticOutputFixtureConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount > 3);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "bad-output" && item.ok), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "good-output" && item.ok), true);
  assert.equal(result.assistantMessage, "analysis complete");
});

test("autonomous runtime rejects degenerate stack-trace call-site output", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: analyze stack traces and write output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Run the analyzer and inspect output.txt.",
      steps: [
        {
          id: "finalize",
          title: "Analyze stack traces",
          type: "finalize",
          instructions: "Generate output.txt and complete only if the call-site distribution is meaningful.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "degenerate-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 285 stack traces\\nNumber of unique call sites (based on top 3 frames): 1\\nTotal stack traces analyzed: 285\\n\\nMost common call sites:\\n\\n1. Count: 285\\n  Frame 1: printStack()\\n  Frame 2: frame2\\n  Frame 3: frame3\\n'",
          },
        },
        { id: "bad-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "good-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n'",
          },
        },
        { id: "good-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createSemanticOutputFixtureConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount > 2);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "degenerate-output" && item.ok), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "good-output" && item.ok), true);
  assert.equal(result.assistantMessage, "analysis complete");
});

test("autonomous runtime rejects stack-trace output below observed numeric marker", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: analyze stack traces and write output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Inspect log.stack and run the analyzer.",
      steps: [
        {
          id: "finalize",
          title: "Analyze stack traces",
          type: "finalize",
          instructions: "Generate output.txt and complete only if the trace count is plausible.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        { id: "inspect-log", name: "run_shell_command", args: { cmd: "printf '285\\n\\t in frame1\\n' # log.stack" } },
        {
          id: "too-few-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 3 stack traces\\nNumber of unique call sites (based on top 3 frames): 2\\nTotal stack traces analyzed: 3\\n\\nMost common call sites:\\n'",
          },
        },
        { id: "bad-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "good-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n'",
          },
        },
        { id: "good-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createSemanticOutputFixtureConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount > 2);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "too-few-output" && item.ok), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "good-output" && item.ok), true);
  assert.equal(result.assistantMessage, "analysis complete");
});

test("autonomous runtime rejects stack-trace frame lines with raw in prefix", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: analyze stack traces and write output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Strip raw stack-frame prefixes.",
      steps: [
        {
          id: "finalize",
          title: "Analyze stack traces",
          type: "finalize",
          instructions: "Generate output.txt and complete only if frame content is clean.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "prefixed-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n\\n1. Count: 55\\n  Frame 1: in printStack()\\n'",
          },
        },
        { id: "bad-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "good-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n\\n1. Count: 55\\n   Frame 1: printStack()\\n'",
          },
        },
        { id: "good-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createSemanticOutputFixtureConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount > 2);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "prefixed-output" && item.ok), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "good-output" && item.ok), true);
  assert.equal(result.assistantMessage, "analysis complete");
});

test("autonomous runtime rejects two-space stack-trace frame indentation", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: analyze stack traces and write output.txt.",
  };
  const gateway = new StaticJsonGateway([
    {
      installs: [],
      testGuidance: "Match exact stack-trace output formatting.",
      steps: [
        {
          id: "finalize",
          title: "Analyze stack traces",
          type: "finalize",
          instructions: "Generate output.txt and complete only if frame indentation is exact.",
        },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "two-space-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n\\n1. Count: 55\\n  Frame 1: printStack()\\n'",
          },
        },
        { id: "bad-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
    {
      assistant_message: "",
      tool_calls: [
        {
          id: "good-output",
          name: "run_shell_command",
          args: {
            cmd:
              "printf 'Found 646 stack traces\\nNumber of unique call sites (based on top 3 frames): 317\\nTotal stack traces analyzed: 646\\n\\nMost common call sites:\\n\\n1. Count: 55\\n   Frame 1: printStack()\\n'",
          },
        },
        { id: "good-complete", name: "complete_task", args: { summary: "analysis complete" } },
      ],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createSemanticOutputFixtureConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.ok(gateway.generateCount > 2);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "two-space-output" && item.ok), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "good-output" && item.ok), true);
  assert.equal(result.assistantMessage, "analysis complete");
});

test("runtime engine can summarize with a live model when available", { skip: !(process.env.RUN_LIVE_LLM_TESTS === "1" && process.env.DEEPSEEK_API_KEY) }, async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Read the README and tell me what happened",
    tool_calls: [{ id: "1", name: "read_file", args: { path: "README.md" } }],
  };

  const { config, gateway } = createLiveDeepSeekGateway("runtime engine can summarize with a live model when available");

  const engine = new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();
  assert.match(result.assistantMessage.toLowerCase(), /readme|workspace|temp/);
});

function createSemanticOutputFixtureConfig() {
  const config = createValidConfig();
  config.runtime.artifactObligations.enabled = false;
  return config;
}

class StaticJsonGateway implements ModelGateway {
  generateCount = 0;
  private readonly responses: unknown[];
  private readonly queuedResponses: unknown[] = [];

  constructor(response: unknown | unknown[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.generateCount += 1;
    const response = this.normalizeResponse(this.queuedResponses.shift() ?? this.responses[Math.min(this.generateCount - 1, this.responses.length - 1)]);
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      content: JSON.stringify(response),
      finishReason: "stop",
      raw: response,
    };
  }

  private normalizeResponse(response: unknown): unknown {
    const record = response && typeof response === "object" ? (response as Record<string, unknown>) : undefined;
    if (!record) return response;
    if (!Array.isArray(record.tool_calls) && Array.isArray(record.steps)) {
      return this.normalizeResponse({
        assistant_message: "",
        tool_calls: record.steps.flatMap((step) => {
          const stepRecord = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
          return Array.isArray(stepRecord.tool_calls) ? stepRecord.tool_calls : [];
        }),
      });
    }
    if (!Array.isArray(record.tool_calls)) return response;
    const completionIndex = record.tool_calls.findIndex((call) => isToolCallNamed(call, "complete_task"));
    if (completionIndex < 0) return response;
    const beforeCompletion = record.tool_calls.slice(0, completionIndex);
    if (!beforeCompletion.some(isMutatingFixtureToolCall)) return response;
    this.queuedResponses.unshift({
      assistant_message: "",
      tool_calls: [record.tool_calls[completionIndex]],
    });
    return {
      ...record,
      tool_calls: beforeCompletion,
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "embedder",
      profileName: "embedder",
      provider: "test",
      model: "static-json",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}

function isToolCallNamed(value: unknown, name: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { name?: unknown }).name === name);
}

function isMutatingFixtureToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && ["write_file", "replace_in_file", "edit_file", "delete_file", "run_shell_command"].includes(name);
}
