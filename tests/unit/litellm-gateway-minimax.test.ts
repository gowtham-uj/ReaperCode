import test from "node:test";
import assert from "node:assert/strict";

import { LiteLLMProviderClient } from "../../src/model/providers/litellm-gateway.js";
import type { GenerateRequest, ResolvedModelProfile } from "../../src/model/types.js";

function makeProfile(provider = "minimax", model = "MiniMax-M3"): ResolvedModelProfile {
  return {
    provider,
    model,
    role: "secondary_model",
    profileName: "default_model",
    apiKeyEnv: "MINIMAX_API_KEY",
    apiBase: "https://api.minimax.io/v1",
    timeoutMs: 30_000,
    maxRetries: 0,
    defaultParams: { maxTokens: 8192 },
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
    },
  };
}

function makeRequest(responseFormat?: "json"): GenerateRequest {
  return {
    role: "secondary_model",
    messages: [{ role: "user", content: "Return JSON." }],
    maxTokens: 128,
    ...(responseFormat ? { responseFormat } : {}),
  };
}

test("MiniMax JSON generate uses buffered non-stream request", async () => {
  process.env.MINIMAX_API_KEY = "test-key";
  const bodies: unknown[] = [];
  const client = new LiteLLMProviderClient({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          model: "MiniMax-M3",
          choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.generate(makeRequest("json"), makeProfile());

  assert.equal(result.content, "{\"ok\":true}");
  assert.equal((bodies[0] as { stream?: boolean }).stream, false);
  assert.deepEqual((bodies[0] as { response_format?: unknown }).response_format, { type: "json_object" });
});

test("MiniMax non-JSON generate keeps streaming request path", async () => {
  process.env.MINIMAX_API_KEY = "test-key";
  const bodies: unknown[] = [];
  const client = new LiteLLMProviderClient({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  const result = await client.generate(makeRequest(), makeProfile());

  assert.equal(result.content, "ok");
  assert.equal((bodies[0] as { stream?: boolean }).stream, true);
});
