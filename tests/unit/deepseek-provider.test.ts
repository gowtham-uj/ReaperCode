import test from "node:test";
import assert from "node:assert/strict";

import { DeepSeekClient } from "../../src/model/providers/deepseek.js";
import type { ResolvedModelProfile } from "../../src/model/types.js";

test("DeepSeek generate preserves stable system prefix and exposes cache usage", async () => {
  const previousApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let capturedBody: any;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      [
        `data: ${JSON.stringify({ model: "deepseek-v4-pro", choices: [{ delta: { content: "ok" } }] })}\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 1,
            total_tokens: 101,
            prompt_cache_hit_tokens: 64,
            prompt_cache_miss_tokens: 36,
          },
        })}\n`,
        "data: [DONE]\n",
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const client = new DeepSeekClient({ fetchImpl });
    const result = await client.generate(
      {
        role: "secondary_model",
        system: "stable system prefix ".repeat(20),
        messages: [{ role: "user", content: "dynamic request" }],
        maxTokens: 64,
      },
      profile(),
    );

    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(typeof capturedBody.messages[0].content, "string");
    assert.equal(capturedBody.messages[1].role, "user");
    assert.equal(capturedBody.stream_options.include_usage, true);
    assert.deepEqual(capturedBody.thinking, { type: "disabled" });
    assert.equal(result.content, "ok");
    const raw = result.raw as any;
    assert.equal(raw.promptCache.enabled, true);
    assert.equal(raw.promptCache.mode, "provider_automatic_prefix_cache");
    assert.equal(raw.usage.prompt_cache_hit_tokens, 64);
    assert.equal(raw.usage.prompt_cache_miss_tokens, 36);
  } finally {
    restoreEnv("DEEPSEEK_API_KEY", previousApiKey);
  }
});

test("DeepSeek stream includes usage so cache hit rate can be audited", async () => {
  const previousApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let capturedBody: any;
  const fetchImpl: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_cache_hit_tokens: 128,
            prompt_cache_miss_tokens: 32,
          },
        })}\n`,
        "data: [DONE]\n",
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const client = new DeepSeekClient({ fetchImpl });
    const events = [];
    for await (const event of client.stream(
      {
        role: "secondary_model",
        system: "stable system prefix ".repeat(20),
        messages: [{ role: "user", content: "dynamic request" }],
      },
      profile(),
    )) {
      events.push(event);
    }

    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.stream_options.include_usage, true);
    const end = events.find((event) => event.type === "message_end");
    assert.equal((end?.data as any).usage.prompt_cache_hit_tokens, 128);
    assert.equal((end?.data as any).usage.prompt_cache_miss_tokens, 32);
  } finally {
    restoreEnv("DEEPSEEK_API_KEY", previousApiKey);
  }
});

function profile(): ResolvedModelProfile {
  return {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    profileName: "default_model",
    role: "secondary_model",
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
    defaultParams: {
      promptCache: {
        enabled: true,
        minContentChars: 256,
      },
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
