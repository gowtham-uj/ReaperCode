/**
 * The agent loop must not cap how many model turns a run may take.
 *
 * It used to. `langgraphRecursionLimit` defaulted to 50 and the live loop was
 * `while (liveIteration < liveIterationLimit)`, so a run that needed a 51st turn
 * simply stopped: the last thing in the transcript was a tool result, with no
 * follow-up, no error, and nothing to act on. Observed in a real session whose
 * journal recorded turn_index 0 through 49 and then ended mid-work.
 *
 * The name was wrong as well as the behaviour. The engine's loop is a plain
 * `for (;;)`; there has been no LangGraph in this path since the loop was
 * rewritten, so the knob was a leftover that silently governed the loop.
 *
 * This pins the removal at the level that matters: a model that keeps calling
 * tools past the old limit keeps getting called.
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

/** Well past the old limit of 50, so a cap of any tolerated size is caught. */
const TURNS = 70;

/**
 * A model that calls a cheap tool for TURNS turns and only then answers.
 *
 * Every call is a real, valid `list_directory`, so the loop advances normally
 * and nothing else in the runtime has a reason to stop it. Any stop before
 * TURNS is therefore the cap and nothing else.
 */
class EndlessToolGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];
  private callIndex = 0;

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "no-iteration-cap-probe",
      capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
    };
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw new Error("generate not used");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const index = this.callIndex;
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "no-iteration-cap-probe" } };
    if (index < TURNS) {
      yield { type: "tool_call", data: { id: `call-${index}`, name: "list_directory", arguments: JSON.stringify({ path: "." }) } };
    } else {
      yield { type: "message_delta", content: "Finished after the long haul." };
    }
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "no-iteration-cap-probe",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return Math.ceil(request.text.length / 4);
  }
}

test("a run is not stopped by a model-turn cap", async () => {
  const workspaceRoot = await createTempWorkspace();
  const userHome = await mkdtemp(path.join(tmpdir(), "reaper-no-cap-home-"));
  await mkdir(path.join(userHome, ".config", "reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "marker.txt"), "alpha\n", "utf8");

  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Keep listing the directory until you are certain, then summarise." };

  const gateway = new EndlessToolGateway();
  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    userHome,
  }).run();

  const mainCalls = gateway.requests.filter((item) => item.source === "main_agent").length;
  const codes = (result.runtimeBlockers ?? []).map((blocker) => blocker.code);

  assert.ok(
    mainCalls > TURNS,
    `the loop stopped after ${mainCalls} model calls; a cap is still in force (expected more than ${TURNS})`,
  );
  assert.ok(
    !codes.includes("iteration_limit"),
    `the run reported an iteration cap: ${codes.join(", ")}`,
  );
  assert.match(result.assistantMessage, /Finished after the long haul/);
});
