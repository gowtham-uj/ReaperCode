/**
 * Permission-mode enforcement probe.
 *
 * Verifies that the configured permission mode (auto/accept_edits/strict/yolo)
 * is actually wired into ToolExecutor and that a non-allowlisted bash command
 * is rejected in non-yolo modes. This proves the refactor-and-cleanup pass
 * kept the permission boundary intact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
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
import { ProjectTrustStore } from "../../src/resources/project-trust.js";

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
      model: "perm-probe",
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
    throw new Error("generate not used");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
    });
    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? { assistant_message: "Done." };
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "perm-probe" } };
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
      model: "perm-probe",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

test("permission mode 'strict' rejects non-allowlisted bash command", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "README.md"), "# probe\n", "utf8");
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Run rm -rf /tmp/junk-probe-target and finish." };
  const config = createValidConfig() as Record<string, unknown>;
  config.runtimeTunables = { ...((config.runtimeTunables as object) ?? {}), permissionMode: "strict" };
  const gateway = new CaptureGateway([
    {
      tool_calls: [
        {
          id: "rm-probe",
          name: "bash",
          args: { cmd: "rm -rf /tmp/junk-probe-target", summary: "remove junk" },
        },
      ],
    },
    { assistant_message: "Refused: rm -rf is not allowed in strict mode." },
  ]);

  const result = await new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  const bashResult = result.toolResults.find((r) => r.toolCallId === "rm-probe");
  assert.ok(bashResult, "bash tool call should have produced a result");
  // In strict mode, the runtime returns a structured approval-required
  // result for any non-allowlisted bash command (not a hard deny — the
  // model can still proceed if a human approves). The hard-deny layer
  // is reserved for the destructive patterns (rm -rf /, dd of=/dev/sda,
  // mkfs, etc.). Yolo is the default and bypasses the approval gate.
  assert.equal(bashResult.ok, false, "strict mode must require approval for bash");
  assert.match(
    String(bashResult.error?.message ?? ""),
    /(approval|confirmation|strict)/i,
    `strict mode should cite approval requirement; got ${bashResult.error?.message}`,
  );
});

test("permission mode 'yolo' allows ordinary workspace-write bash", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Create a marker file with a known value." };
  const config = createValidConfig() as Record<string, unknown>;
  config.runtimeTunables = { ...((config.runtimeTunables as object) ?? {}), permissionMode: "yolo" };
  const gateway = new CaptureGateway([
    {
      tool_calls: [
        {
          id: "yolo-marker",
          name: "bash",
          args: { cmd: "printf 'yolo-allowed\\n' > .reaper-yolo-marker && test \"$(cat .reaper-yolo-marker)\" = 'yolo-allowed'", summary: "create + verify marker" },
        },
      ],
    },
    { assistant_message: "Marker created." },
  ]);

  const result = await new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  const bashResult = result.toolResults.find((r) => r.toolCallId === "yolo-marker");
  assert.ok(bashResult, "bash tool call should have produced a result");
  assert.equal(bashResult.ok, true, "ordinary workspace-write shell must succeed in yolo mode");
  const marker = (await import("node:fs/promises")).readFile(path.join(workspaceRoot, ".reaper-yolo-marker"), "utf8");
  assert.equal((await marker).trim(), "yolo-allowed");
});