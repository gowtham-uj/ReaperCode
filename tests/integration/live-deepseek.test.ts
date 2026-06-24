import test from "node:test";
import assert from "node:assert/strict";

import {
  createLiveDeepSeekConfig,
  createLiveDeepSeekGateway,
  createLoggedGatewayFromConfig,
} from "../fixtures/live-gateway.js";
import { getDefaultDeepSeekModel } from "../fixtures/live-models.js";

const deepSeekKeyPresent = process.env.RUN_LIVE_LLM_TESTS === "1" && Boolean(process.env.DEEPSEEK_API_KEY);

test(
  "live DeepSeek generate call works with config-only provider selection",
  { skip: !deepSeekKeyPresent },
  async () => {
    const { gateway } = createLiveDeepSeekGateway("live DeepSeek generate call works with config-only provider selection");
    const result = await gateway.generate({
      role: "main_reasoner",
      messages: [{ role: "user", content: "Reply with exactly the word: ok" }],
      maxTokens: 512,
    });

    assert.match(result.content.toLowerCase(), /ok/);
    assert.equal(result.provider, "deepseek");
  },
);

test(
  "live DeepSeek streaming call emits normalized events",
  { skip: !deepSeekKeyPresent },
  async () => {
    const { gateway } = createLiveDeepSeekGateway("live DeepSeek streaming call emits normalized events");
    const events = [] as string[];
    let reasoning = "";
    let content = "";

    for await (const event of gateway.stream({
      role: "main_reasoner",
      messages: [{ role: "user", content: "Reply with exactly the word: ok" }],
      maxTokens: 512,
    })) {
      events.push(event.type);
      if (event.type === "reasoning_delta" && event.content) reasoning += event.content;
      if (event.type === "message_delta" && event.content) content += event.content;
    }

    assert.ok(events.includes("message_start"));
    assert.ok(events.includes("message_end"));
    assert.ok(reasoning || content);
  },
);

test(
  "live DeepSeek fallback works when primary model is invalid and fallback role is configured",
  { skip: !deepSeekKeyPresent },
  async () => {
    const config = createLiveDeepSeekConfig("definitely-not-a-real-model");
    config.models.default_model.fallbackProfile = "judge";
    config.models.judge = {
      provider: "deepseek",
      model: getDefaultDeepSeekModel(),
      apiKeyEnv: "DEEPSEEK_API_KEY",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };

    process.env.REAPER_DISABLE_MODEL_ROUTER = "1";
    try {
      const gateway = createLoggedGatewayFromConfig(
        config,
        "live DeepSeek fallback works when primary model is invalid and fallback role is configured",
      );
      const result = await gateway.generate({
        role: "main_reasoner",
        messages: [{ role: "user", content: "Reply with exactly the word: fallback" }],
        maxTokens: 512,
      });

      assert.match(result.content.toLowerCase(), /fallback/);
      assert.equal(result.profileName, "judge");
    } finally {
      delete process.env.REAPER_DISABLE_MODEL_ROUTER;
    }
  },
);
