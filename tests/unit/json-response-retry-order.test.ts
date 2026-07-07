/**
 * Regression: MiniMax-M3 can return a non-truncated `<think>...</think>`
 * parse failure for text_json, then a length-truncated provider_json response.
 * Parser feedback must win over max-token doubling in that mixed-failure case;
 * otherwise Reaper escalates to a huge 16K retry that can hang parity runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateStructuredJson } from "../../src/model/json-response.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";

function parseEnvelope(value: unknown): { assistant_message: string; tool_calls: unknown[] } {
  const obj = value as { assistant_message?: unknown; tool_calls?: unknown };
  if (typeof obj.assistant_message !== "string" || !Array.isArray(obj.tool_calls)) {
    throw new Error("expected Reaper executor envelope");
  }
  return { assistant_message: obj.assistant_message, tool_calls: obj.tool_calls };
}

test("generateStructuredJson: mixed stop parse failure + length truncation uses parser feedback before max-token doubling", async () => {
  const requests: GenerateRequest[] = [];
  const profile: ResolvedModelProfile = {
    provider: "minimax",
    model: "MiniMax-M3",
    profileName: "secondary_model",
    role: "secondary_model",
    defaultParams: { maxTokens: 8192 },
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxOutputTokens: 32768,
    },
    timeoutMs: 30_000,
  };

  const gateway: ModelGateway = {
    async resolveRole(): Promise<ResolvedModelProfile> {
      return profile;
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      requests.push(request);
      if (requests.length === 1) {
        return {
          content: "<think>I should build the app, but I forgot JSON.</think>",
          provider: "minimax",
          model: "MiniMax-M3",
          profileName: profile.profileName,
          role: request.role,
          finishReason: "stop",
          raw: {},
        };
      }
      if (requests.length === 2) {
        return {
          content: '{"assistant_message":"partial',
          provider: "minimax",
          model: "MiniMax-M3",
          profileName: profile.profileName,
          role: request.role,
          finishReason: "length",
          raw: {},
        };
      }
      return {
        content: JSON.stringify({ assistant_message: "parser feedback fixed it", tool_calls: [] }),
        provider: "minimax",
        model: "MiniMax-M3",
        profileName: profile.profileName,
        role: request.role,
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
      throw new Error("stream unused in this regression");
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return {
        role: request.role,
        profileName: request.role,
        provider: "minimax",
        model: "MiniMax-M3",
        vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
        raw: {},
      };
    },
    async countTokens(_request: TokenCountRequest): Promise<number> {
      return 0;
    },
  };

  const result = await generateStructuredJson({
    modelGateway: gateway,
    role: "secondary_model",
    messages: [{ role: "user", content: "build app" }],
    parse: parseEnvelope,
  });

  assert.equal(result.assistant_message, "parser feedback fixed it");
  assert.equal(requests.length, 3, "must retry once with parser feedback, not doubled maxTokens");
  assert.equal(requests[2]?.maxTokens, undefined, "parser-feedback retry must not escalate maxTokens to 16384");
  assert.match(requests[2]?.messages.at(-1)?.content ?? "", /previous response did not satisfy/);
});
