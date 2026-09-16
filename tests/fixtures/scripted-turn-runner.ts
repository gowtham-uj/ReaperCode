/**
 * A managed-turn runner backed by a scripted model.
 *
 * The engine, the loop, the event bus, the session projection, and the
 * app-server are all the production ones; only the model is fake. That is the
 * point of putting it here rather than stubbing the protocol: a test using this
 * exercises the real path end to end, which is the only way to catch a client
 * that waits for a notification the server does not actually send.
 *
 * `script` is one entry per model call, each a list of stream events, so a
 * multi-step turn (prose, a tool call, more prose) can be described without a
 * provider.
 */
import type { EmbeddingRequest, EmbeddingResult, GenerateRequest, GenerateResult, ModelGateway, ModelRole, ResolvedModelProfile, StreamEvent } from "../../src/model/types.js";
import type { ManagedTurnRunner, ManagedTurnRunnerInput } from "../../src/app-server/managed-turn-runner.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "./phase0.js";

export type TurnScript = Array<Array<StreamEvent>>;

/** A gateway that replays `script`, holding on the last entry once exhausted. */
export function scriptedGateway(script: TurnScript): ModelGateway {
  let call = 0;
  return {
    async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
      return {
        role,
        profileName: role,
        provider: "test",
        model: "scripted",
        capabilities: { streaming: true, toolCalling: true, jsonMode: false, structuredOutput: false, embeddings: false },
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      const events = script[Math.min(call, script.length - 1)] ?? [];
      call += 1;
      yield { type: "message_start", data: {} };
      for (const event of events) yield event;
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "scripted", content: "", finishReason: "stop", raw: {} };
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "scripted", vectors: [], raw: {} };
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  };
}

/**
 * A turn runner that drives the real engine against `script`.
 *
 * The gateway is built ONCE, outside the returned closure, so its call counter
 * spans every turn the runner serves. Building it inside meant each turn
 * restarted at `script[0]`, and a second turn replayed the first turn's
 * response — which looked like a client bug (the second call returning the
 * first call's answer) and was actually the fixture lying about the model.
 */
export function scriptedTurnRunner(script: TurnScript): ManagedTurnRunner {
  const gateway = scriptedGateway(script);
  return async (input: ManagedTurnRunnerInput) => {
    const request = createValidRequestEnvelope();
    request.payload = { prompt: input.prompt };
    const engine = new RuntimeEngine({
      config: createValidConfig(),
      workspaceRoot: input.workspaceRoot,
      requestEnvelope: request,
      modelGateway: gateway,
      eventSink: input.eventSink,
      abortSignal: input.abortSignal,
      approvalRequester: input.approvalRequester,
      turnControl: input.turnControl,
      // The app-server path never writes to stdout directly; every byte of
      // output is a typed event. Keeping that here is what makes the CLI test
      // exercise the same rendering the web UI gets.
      writeHumanOutput: false,
    });
    return await engine.run();
  };
}
