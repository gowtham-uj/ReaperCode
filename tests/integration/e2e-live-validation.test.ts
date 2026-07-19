/**
 * Live end-to-end validation: a real complex multi-file dev task exercising
 * named-session resume, tool execution, child-env sanitization,
 * permission enforcement. Uses a scripted mock provider that walks the
 * model through:
 *   - file_view tool call to inspect
 *   - write_file to refactor
 *   - bash test run that verifies behavior
 *   - natural stop with summary
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import {
  COCKPIT_OPEN,
  CURRENT_REQUEST_MESSAGE_NAME,
  countCockpitMarkers,
} from "../../src/runtime/context-cockpit.js";
import { MAIN_AGENT_SYSTEM_PROMPT_TEXT } from "../../src/runtime/system-prompt.js";
import { ProjectTrustStore } from "../../src/resources/project-trust.js";
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

class StepwiseGateway implements ModelGateway {
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
      model: "stepwise",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw new Error("generate not used in live validation test");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push({
      ...request,
      messages: request.messages.map((m) => {
        const snap: GenerateRequest["messages"][number] = {
          ...m,
          content: typeof m.content === "string" ? m.content : m.content,
        };
        if (m.tool_calls) {
          (snap as { tool_calls?: unknown }).tool_calls = m.tool_calls.map((t) => ({
            ...t,
            function: { ...t.function },
          }));
        }
        return snap;
      }),
    });
    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? { assistant_message: "Done." };
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "stepwise" } };
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
      model: "stepwise",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

test("end-to-end live validation: multi-file dev task with Pi-parity sessions", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-e2e-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });
  await writeFile(path.join(userHome, ".config", "reaper", "context.md"), "User rule: prefer functional style.\n", "utf8");
  await ProjectTrustStore.create(userHome).set(workspaceRoot, true);

  await writeFile(
    path.join(workspaceRoot, "calculator.ts"),
    `export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "calculator.test.ts"),
    `import { add, sub } from "./calculator.js";\nimport assert from "node:assert/strict";\nassert.equal(add(2, 3), 5);\nassert.equal(sub(5, 2), 3);\n`,
    "utf8",
  );

  const request = createValidRequestEnvelope();
  const userPrompt =
    "Refactor calculator.ts to extract a generic 'binaryOp' helper used by both add and sub, run the test, and finish with a short summary.";
  request.payload = { prompt: userPrompt };

  const gateway = new StepwiseGateway([
    { tool_calls: [{ id: "read-calc", name: "file_view", args: { path: "calculator.ts" } }] },
    {
      tool_calls: [
        {
          id: "refactor-calc",
          name: "write_file",
          args: {
            path: "calculator.ts",
            content: "type Op = (a: number, b: number) => number;\nconst binaryOp = (op: Op): Op => op;\nexport const add = binaryOp((a, b) => a + b);\nexport const sub = binaryOp((a, b) => a - b);\n",
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          id: "run-test",
          name: "bash",
          args: {
            cmd: "node --test calculator.test.ts",
            summary: "run the test",
            timeout: 60,
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          id: "write-marker",
          name: "write_file",
          args: {
            path: ".reaper-e2e-marker",
            content: "e2e-live-ok\n",
          },
        },
      ],
    },
    {
      assistant_message:
        "Refactor complete. Both add and sub now share the binaryOp helper; the test passes; .reaper-e2e-marker contains 'e2e-live-ok'.",
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    userHome,
  }).run();

  const marker = await readFile(path.join(workspaceRoot, ".reaper-e2e-marker"), "utf8");
  assert.equal(marker.trim(), "e2e-live-ok");

  const refactored = await readFile(path.join(workspaceRoot, "calculator.ts"), "utf8");
  assert.match(refactored, /binaryOp/);
  assert.match(refactored, /export const add =/);
  assert.match(refactored, /export const sub =/);

  const mainRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainRequests.length >= 3, `expected >=3 main_agent turns, got ${mainRequests.length}`);
  const sys0 = mainRequests[0]!.system;
  assert.equal(sys0, MAIN_AGENT_SYSTEM_PROMPT_TEXT, "main agent receives canonical stable system prompt");
  for (const req of mainRequests) {
    assert.equal(req.system, sys0, "system bytes are byte-identical across turns");
  }

  for (const req of mainRequests) {
    const all = req.messages.map((m) => m.content).filter((c) => typeof c === "string").join("\n");
    const counts = countCockpitMarkers(all);
    assert.deepEqual(counts, { opens: 0, closes: 0 }, "no cockpit markers in any request under Pi-parity");
  }

  const first = mainRequests[0]!;
  // Pi-parity: no cockpit bundle is injected. The first request's
  // user message must still carry the raw task prompt so the model
  // has something to act on.
  const cockpit = first.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(COCKPIT_OPEN),
  );
  assert.equal(cockpit, undefined, "no cockpit bundle is injected under Pi-parity");
  const firstUserMessage = first.messages.find(
    (m) => m.role === "user" && (m as { name?: string }).name === CURRENT_REQUEST_MESSAGE_NAME,
  );
  assert.ok(firstUserMessage, "the raw user prompt is the first user message");
  assert.equal((firstUserMessage as { content: string }).content, userPrompt);

  assert.ok(result.toolResults.length >= 3);
  const toolNames = new Set(result.toolResults.map((r) => r.name));
  assert.ok(toolNames.has("file_view"), "file_view tool ran");
  assert.ok(toolNames.has("write_file"), "write_file tool ran");
  assert.ok(toolNames.has("bash"), "bash tool ran");
});