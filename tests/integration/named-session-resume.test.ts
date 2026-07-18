/**
 * Named-session resume: confirms the cockpit is stripped from the prior
 * run's snapshot and re-inserted fresh on the next run when the same
 * named session is requested. This exercises the resume path the
 * refactor-and-cleanup pass specifically preserved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { COCKPIT_OPEN, countCockpitMarkers } from "../../src/runtime/context-cockpit.js";
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
      model: "resume-probe",
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
    yield { type: "message_start", data: { provider: "test", model: "resume-probe" } };
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
      model: "resume-probe",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

test("named-session resume reinserts a fresh cockpit after stripping the prior run's snapshot", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-resume-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "marker.txt"), "alpha\n", "utf8");

  const sessionName = `reaper-resume-${Date.now()}`;

  // First run: make a write so the journal has history.
  const requestA = createValidRequestEnvelope();
  requestA.payload = { prompt: "Append 'beta' to marker.txt." };
  const gatewayA = new CaptureGateway([
    {
      tool_calls: [
        { id: "write-alpha", name: "write_file", args: { path: "marker.txt", content: "alpha\nbeta\n" } },
      ],
    },
    { assistant_message: "Marker updated." },
  ]);
  await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: requestA,
    modelGateway: gatewayA,
    userHome,
    namedSession: sessionName,
  }).run();

  // Second run: same named session. The prior cockpit from run A
  // should be stripped from the resumed snapshot, and a fresh cockpit
  // inserted for run B.
  const requestB = createValidRequestEnvelope();
  requestB.payload = { prompt: "Confirm marker.txt now contains alpha+beta." };
  const gatewayB = new CaptureGateway([
    {
      tool_calls: [
        { id: "read-marker", name: "file_view", args: { path: "marker.txt" } },
      ],
    },
    { assistant_message: "Confirmed: marker.txt contains alpha+beta." },
  ]);
  await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: requestB,
    modelGateway: gatewayB,
    userHome,
    namedSession: sessionName,
  }).run();

  const mainRequestsB = gatewayB.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainRequestsB.length >= 1, "expected at least one main_agent request in run B");

  // Cockpit present, exactly one pair, slim envelope.
  const first = mainRequestsB[0]!;
  const all = first.messages.map((m) => m.content).filter((c) => typeof c === "string").join("\n");
  assert.deepEqual(countCockpitMarkers(all), { opens: 1, closes: 1 });
  const cockpit = first.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(COCKPIT_OPEN),
  );
  assert.ok(cockpit, "fresh cockpit present in resumed run");
  assert.doesNotMatch((cockpit as { content: string }).content, /npm=|docker=|tools=/, "resumed cockpit is the slim envelope");
});