/**
 * Debug loop: stub failing test → model reads failure → fixes source →
 * re-runs test → succeeds → summary. Exercises reactive-compact and
 * error-classifier paths because the first test run returns a failing
 * result, the model reacts, and the second run succeeds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

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
import { createTempWorkspace } from "../fixtures/workspace.js";

class CaptureGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];
  private readonly responses: Array<{
    assistant_message?: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }>;
  private callIndex = 0;

  constructor(responses: Array<{
    assistant_message?: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }>) {
    this.responses = responses;
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "debug-loop",
      capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
    };
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw new Error("generate not used");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? { assistant_message: "Done." };
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "debug-loop" } };
    if (response.assistant_message) {
      yield { type: "message_delta", content: response.assistant_message };
    }
    for (const call of response.tool_calls ?? []) {
      yield { type: "tool_call", data: { id: call.id, name: call.name, arguments: JSON.stringify(call.args) } };
    }
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "debug-loop",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

test("debug loop: stub failing test → diagnose → fix → re-run → succeed", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-dbg-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });

  // Seed a deliberately-buggy implementation and a strict test that
  // initially fails. The model must diagnose and fix.
  await writeFile(
    path.join(workspaceRoot, "doubler.ts"),
    `export function double(n: number): number {\n  return n + 1; // off-by-one bug\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "doubler.test.ts"),
    `import { double } from "./doubler.js";\nimport assert from "node:assert/strict";\nassert.equal(double(3), 6);\nassert.equal(double(0), 0);\nassert.equal(double(-4), -8);\n`,
    "utf8",
  );

  const request = createValidRequestEnvelope();
  const userPrompt = "Run the test, find the bug, fix it, and confirm green.";
  request.payload = { prompt: userPrompt };

  const gateway = new CaptureGateway([
    // Turn 1: read the test + source to understand the failure.
    {
      tool_calls: [
        { id: "run-test-1", name: "bash", args: { cmd: "node --test doubler.test.ts", summary: "first run" } },
      ],
    },
    {
      tool_calls: [
        { id: "fix-doubler", name: "write_file", args: { path: "doubler.ts", content: "export function double(n: number): number {\n  return n * 2;\n}\n" } },
      ],
    },
    {
      tool_calls: [
        { id: "run-test-2", name: "bash", args: { cmd: "node --test doubler.test.ts", summary: "re-run after fix" } },
      ],
    },
    {
      tool_calls: [
        { id: "write-debug-marker", name: "write_file", args: { path: ".reaper-debug-marker", content: "debug-loop-ok\n" } },
      ],
    },
    {
      assistant_message: "Bug fixed. doubler now multiplies by 2 and the test passes; .reaper-debug-marker contains 'debug-loop-ok'.",
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    userHome,
  }).run();

  // Acceptance: marker file written, source fixed, ≥ 4 main_agent turns.
  const marker = await readFile(path.join(workspaceRoot, ".reaper-debug-marker"), "utf8");
  assert.equal(marker.trim(), "debug-loop-ok");
  const fixed = await readFile(path.join(workspaceRoot, "doubler.ts"), "utf8");
  assert.match(fixed, /n \* 2/);
  const mainRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainRequests.length >= 4, `expected ≥4 main_agent turns for debug loop, got ${mainRequests.length}`);

  // Tool results captured at least the two bash runs and the fix write.
  const bashResults = result.toolResults.filter((r) => r.name === "bash");
  assert.ok(bashResults.length >= 2, "two bash invocations captured");
  const writeResults = result.toolResults.filter((r) => r.name === "write_file");
  assert.ok(writeResults.length >= 1, "write_file tool captured");
});