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
      { id: "3", name: "bash", args: { cmd: "node -e \"console.log('verify-ok')\"" } },
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
  assert.ok(typeof result.assistantMessage === "string" && result.assistantMessage.length > 0);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
});

test("runtime engine creates isolated run-local artifacts for placeholder trace ids", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Inspect workspace",
    tool_calls: [{ id: "1", name: "bash", args: { cmd: "printf isolated-run" } }],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();

  assert.match(result.state.runId, /^run-\d{14}-[a-f0-9]{8}$/);
  assert.notEqual(result.state.runId, "trace-1");
  assert.equal(path.normalize(result.trajectoryPath), path.join(workspaceRoot, ".reaper", "runs", result.state.runId, "logs", "reaper-trajectory.jsonl"));

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
      { id: "1", name: "bash", args: { cmd: "node -e \"process.exit(2)\"", timeoutMs: 20 } },
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
  assert.ok(typeof result.assistantMessage === "string");
});

test("explicit tool runs do not trigger an automatic verification node", async () => {
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

test("autonomous runtime executes simple tasks directly and stops naturally", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create simple.txt and verify it.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Executing simple task directly.",
      tool_calls: [
        { id: "write-simple", name: "write_file", args: { path: "simple.txt", content: "simple-ok\n" } },
        { id: "verify-simple", name: "bash", args: { cmd: "test \"$(cat simple.txt)\" = simple-ok" } },
      ],
    },
    {
      assistant_message: "simple.txt was created and verified",
      tool_calls: [],
    },
  ]);

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
  assert.equal(result.verification, undefined);
  assert.equal(await readFile(path.join(workspaceRoot, "simple.txt"), "utf8"), "simple-ok\n");
});

test("autonomous runtime returns final passing verification results to the model for natural stop", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create answer.js, verify it with npm test, then report completion.",
  };
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Writing implementation and tests.",
      tool_calls: [
        { id: "write-answer", name: "write_file", args: { path: "answer.js", content: "export const answer = 42;\n" } },
        {
          id: "write-test",
          name: "write_file",
          args: {
            path: "answer.test.js",
            content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './answer.js';\n\ntest('answer', () => assert.equal(answer, 42));\n",
          },
        },
      ],
    },
    {
      assistant_message: "Running verification.",
      tool_calls: [{ id: "run-tests", name: "bash", args: { cmd: "npm test" } }],
    },
    {
      assistant_message: "Implemented answer.js and verified it with npm test.",
      tool_calls: [],
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
  const requested = requestedToolResults(result.toolResults);
  assert.equal(requested.length, 3);
  assert.equal(requested.every((item) => item.ok), true);
  assert.equal(result.assistantMessage, "Implemented answer.js and verified it with npm test.");
  assert.equal(await readFile(path.join(workspaceRoot, "answer.js"), "utf8"), "export const answer = 42;\n");
  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.doesNotMatch(trajectory, /auto-complete-/);
  assert.match(trajectory, /npm test/);
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
          name: "bash",
          args: { cmd: "python3 -c \"import sys; sys.stderr.write('No module named pip\\n'); sys.exit(1)\"" },
        },
      ],
    },
    {
      assistant_message: "Verifying the pip repair.",
      tool_calls: [
        { id: "pip-fixed", name: "bash", args: { cmd: "python3 -c \"import pip; print(pip.__version__)\"" } },
      ],
    },
    {
      assistant_message: "pip was repaired and verified",
      tool_calls: [],
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
          name: "bash",
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
          name: "bash",
          args: { cmd: "test -s docker-compose.yml && test -s .dockerignore && grep -q services docker-compose.yml && grep -q node_modules .dockerignore" },
        },
      ],
    },
    {
      assistant_message: "Docker files created and verified",
      tool_calls: [],
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

test("autonomous runtime plans once and drains durable execution steps", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create answer.txt and verify it.",
  };
  const gateway = new StaticJsonGateway([
    {
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
          instructions: "Run local verification and finish.",
          tool_calls: [
            { id: "verify-answer-command", name: "bash", args: { cmd: "test \"$(cat answer.txt)\" = ok" } },
          ],
        },
      ],
    },
    {
      assistant_message: "answer.txt was created and verified",
      tool_calls: [],
    },
  ]);

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
  assert.equal(result.verification, undefined);
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
        { id: "verify-deferred", name: "bash", args: { cmd: "test \"$(cat deferred.txt)\" = deferred-ok" } },
      ],
    },
    {
      assistant_message: "deferred.txt was created and verified",
      tool_calls: [],
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
  assert.equal(result.verification, undefined);
  assert.equal(await readFile(path.join(workspaceRoot, "deferred.txt"), "utf8"), "deferred-ok\n");
});

test("autonomous runtime completes work after a mid-plan verification checkpoint", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Complex task: Create two files with a checkpoint between them.",
  };
  const gateway = new StaticJsonGateway([
    {
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
          { id: "checkpoint-first-command", name: "bash", args: { cmd: "node --test tests/checkpoint.test.mjs" } },
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
          { id: "final-verify-command", name: "bash", args: { cmd: "node --test tests/final.test.mjs" } },
        ],
      },
    ],
    },
    {
      assistant_message: "Both files were created and verified.",
      tool_calls: [],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(gateway.generateCount, 2);
  assert.equal(result.events.some((event) => event.message_type === "tool_call_completed"), true);
  assert.equal(result.verification, undefined);
  assert.equal(await readFile(path.join(workspaceRoot, "first.txt"), "utf8"), "ok\n");
  assert.equal(await readFile(path.join(workspaceRoot, "second.txt"), "utf8"), "done\n");
  assert.equal(await readFile(path.join(workspaceRoot, "tests", "final.test.mjs"), "utf8").then((text) => text.includes("both files exist")), true);
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
        { id: "verify-alias", name: "bash", args: { cmd: "test \"$(cat alias.txt)\" = alias-ok" } },
        { id: "replace-alias", name: "replace_in_file", args: { path: "alias.txt", oldString: "alias-ok", newString: "alias-replaced" } },
        { id: "write-type-arguments", name: "write_file", args: { path: "alias-2.txt", content: "alias-2-ok\n" } },
        { id: "read-wrapped-filepath", name: "read_file", args: { path: "alias.txt" } },
        { id: "check-alias-2-exists", name: "bash", args: { cmd: "test -f alias-2.txt" } },
        { id: "check-alias-exists", name: "bash", args: { cmd: "test -f alias.txt" } },
        { id: "verify-alias-2", name: "bash", args: { cmd: "test \"$(cat alias-2.txt)\" = alias-2-ok" } },
        { id: "verify-alias-replaced", name: "bash", args: { cmd: "test \"$(cat alias.txt)\" = alias-replaced" } },
      ],
    },
    {
      assistant_message: "alias.txt was created and verified",
      tool_calls: [],
    },
  ]);

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  assert.equal(requestedToolResults(result.toolResults).length, 9);
  assert.equal(requestedToolResults(result.toolResults).every((item) => item.ok), true);
  assert.equal(await readFile(path.join(workspaceRoot, "alias.txt"), "utf8"), "alias-replaced\n");
  assert.equal(await readFile(path.join(workspaceRoot, "alias-2.txt"), "utf8"), "alias-2-ok\n");
});

test("runtime allows same-batch file inspection through the WAL view after state-changing tools", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Write an output file and inspect it.",
    tool_calls: [
      { id: "write-output", name: "write_file", args: { path: "output.txt", content: "ready\n" } },
      { id: "inspect-output", name: "bash", args: { cmd: "wc -l output.txt && tail -n 1 output.txt", summary: "inspect output file" } },
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

test("autonomous runtime completes the final output check with a natural stop", async () => {
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
      tool_calls: [{ id: "check-output", name: "bash", args: { cmd: "cat output.txt" } }],
    },
    {
      assistant_message: "output.txt verified",
      tool_calls: [],
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


class StaticJsonGateway implements ModelGateway {
  generateCount = 0;
  private readonly responses: unknown[];

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
    const response = this.normalizeResponse(this.responses[Math.min(this.generateCount - 1, this.responses.length - 1)]);
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
      return {
        assistant_message: "",
        tool_calls: record.steps.flatMap((step) => {
          const stepRecord = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
          return Array.isArray(stepRecord.tool_calls) ? stepRecord.tool_calls : [];
        }),
      };
    }
    return response;
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
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

