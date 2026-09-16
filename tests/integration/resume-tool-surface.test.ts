/**
 * A resumed transcript must be sent with every tool it has already called.
 *
 * The failure this pins is the one that produced "the model returned 3 empty
 * responses in a row", which reads like a provider fault and was not one. The
 * sequence was:
 *
 *   Turn 1  the model promotes `extension_manager` with `search_tools`, calls
 *           it, and the call works.
 *   Turn 2  the turn is a resume. `clearDiscoveredTools` runs at the start of
 *           the run, so `extension_manager` is no longer discovered. The
 *           rehydrated transcript still contains the model's earlier calls to
 *           it, but the wire declares only the core tools.
 *
 * An OpenAI-compatible provider silently drops a tool call whose name is not in
 * the request's `tools`, and returns the finish reason with no content and no
 * call. Reaper saw an empty stop three times and failed the turn.
 *
 * Verified against DeepInfra's GLM-5.3-Flash outside Reaper: the identical
 * conversation with `extension_manager` declared returns
 * `finish_reason: "tool_calls"` and a well-formed call; with the core tools only
 * it returns `finish_reason: "stop"`, `content: ""` and 52 tokens of nothing.
 *
 * So the assertion is exact and mechanical: the second run's first request
 * declares every tool the first run's calls named.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
      model: "resume-tool-surface-probe",
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
    yield { type: "message_start", data: { provider: "test", model: "resume-tool-surface-probe" } };
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
      model: "resume-tool-surface-probe",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

/** Every tool name the request declares on the wire. */
function declaredTools(request: GenerateRequest): Set<string> {
  return new Set((request.tools ?? []).map((tool) => (tool as { name?: string }).name ?? ""));
}

/** Every tool name the request's own transcript has already called. */
function calledTools(request: GenerateRequest): Set<string> {
  const names = new Set<string>();
  for (const message of request.messages) {
    const calls = (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = call?.function?.name;
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return names;
}

test("a resumed turn declares every tool its transcript has already called", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-resume-tools-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "marker.txt"), "alpha\n", "utf8");

  /*
   * `extension_manager` is deliberately chosen because it is NOT a core tool.
   * It reaches the wire only by being discovered, which is exactly the state
   * that `clearDiscoveredTools` discards when the next run starts.
   */
  const onDemandTool = "extension_manager";
  const sessionName = `reaper-resume-tools-${Date.now()}`;

  const requestA = createValidRequestEnvelope();
  requestA.payload = { prompt: "List the extensions you can see." };
  const gatewayA = new CaptureGateway([
    { tool_calls: [{ id: "promote", name: "search_tools", args: { query: "extension" } }] },
    { tool_calls: [{ id: "use-extension", name: onDemandTool, args: { action: "validate", id: "probe-x" } }] },
    { assistant_message: "Listed." },
  ]);
  await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: requestA,
    modelGateway: gatewayA,
    userHome,
    namedSession: sessionName,
  }).run();

  const ranFirstTool = gatewayA.requests.some((request) => calledTools(request).has(onDemandTool));
  assert.ok(ranFirstTool, "the first run never called the on-demand tool, so the resume case is not exercised");

  const requestB = createValidRequestEnvelope();
  requestB.payload = { prompt: "Continue." };
  const gatewayB = new CaptureGateway([{ assistant_message: "Continuing." }]);
  await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: requestB,
    modelGateway: gatewayB,
    userHome,
    namedSession: sessionName,
  }).run();

  const mainRequests = gatewayB.requests.filter((request) => request.source === "main_agent");
  assert.ok(mainRequests.length >= 1, "expected at least one main_agent request in the second run");

  const first = mainRequests[0]!;
  const called = calledTools(first);
  assert.ok(
    called.has(onDemandTool),
    "the resumed transcript does not mention the on-demand tool, so this test proves nothing",
  );

  const declared = declaredTools(first);
  const missing = [...called].filter((name) => !declared.has(name));
  assert.deepEqual(
    missing,
    [],
    `the resumed request calls ${missing.join(", ")} without declaring them; a provider drops those calls and the model looks like it answered nothing`,
  );
});
