import test from "node:test";
import assert from "node:assert/strict";

import { mapGenerateRequestToLiteLLM } from "../../src/model/providers/parameter-mapper.js";
import {
  displayModelProfile,
  getModelProfileName,
  profileFromLegacyRole,
  resolveModelRoleAlias,
  type ResolvedModelProfile,
} from "../../src/model/types.js";

test("prompt cache can be enabled explicitly for stable prompt prefixes", () => {
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      system: "x".repeat(300),
      messages: [{ role: "user", content: "dynamic user request" }],
    },
    profile("deepseek", { enabled: true }),
  );

  assert.deepEqual(payload.messages[0], {
    role: "system",
    content: [{ type: "text", text: "x".repeat(300), cache_control: { type: "ephemeral" } }],
  });
});

test("prompt cache can be disabled per profile", () => {
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      system: "x".repeat(300),
      messages: [{ role: "user", content: "dynamic user request" }],
    },
    profile("deepseek", { enabled: false }),
  );

  assert.equal(payload.messages[0]?.content, "x".repeat(300));
});

test("Azure OpenAI payload omits model because deployment is in the URL", () => {
  const previousApiVersion = process.env.AZURE_OPENAI_API_VERSION;
  delete process.env.AZURE_OPENAI_API_VERSION;
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      messages: [{ role: "user", content: "hello" }],
    },
    { ...profile("azure"), apiBase: "https://example.openai.azure.com" },
  );
  restoreEnv("AZURE_OPENAI_API_VERSION", previousApiVersion);

  assert.equal("model" in payload, false);
  assert.equal(payload.messages[0]?.content, "hello");
});

test("Azure OpenAI v1 payload keeps model because endpoint is OpenAI-compatible", () => {
  const previousApiVersion = process.env.AZURE_OPENAI_API_VERSION;
  process.env.AZURE_OPENAI_API_VERSION = "v1";
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      messages: [{ role: "user", content: "hello" }],
    },
    { ...profile("azure"), apiBase: "https://example.openai.azure.com/openai" },
  );
  restoreEnv("AZURE_OPENAI_API_VERSION", previousApiVersion);

  assert.equal("model" in payload, true);
  assert.equal((payload as { model?: string }).model, "model");
  assert.equal(payload.messages[0]?.content, "hello");
});

test("OpenAI-compatible mapper preserves assistant tool calls in standard function shape", () => {
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "ls", arguments: "{\"path\":\".\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "{\"entries\":[\"README.md\"]}" },
      ],
      tools: [{ name: "ls", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    },
    profile("nuralwatt"),
  );

  const messages = payload.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1]?.tool_calls, [
    {
      id: "call_123",
      type: "function",
      function: { name: "ls", arguments: "{\"path\":\".\"}" },
    },
  ]);
  assert.deepEqual(payload.messages[2], {
    role: "tool",
    tool_call_id: "call_123",
    content: "{\"entries\":[\"README.md\"]}",
  });
});

test("model profile naming aliases map legacy roles to tier labels", () => {
  // `secondary_model` is the canonical role name (formerly
  // `secondary_model`). Its display name is the role itself; legacy
  // profile aliases (`strong_model`) still resolve to `secondary_model`.
  assert.equal(getModelProfileName("secondary_model"), "secondary_model");
  assert.equal(getModelProfileName("fast_reasoner"), "fast_model");
  assert.equal(getModelProfileName("judge"), "judge");
  assert.equal(profileFromLegacyRole("secondary_model"), "secondary_model");
  assert.equal(displayModelProfile("secondary_model"), "secondary_model");
  assert.equal(displayModelProfile("strong_model"), "secondary_model");
  // Legacy inputs still resolve cleanly.
  assert.equal(displayModelProfile("secondary_model"), "secondary_model");
  assert.equal(displayModelProfile("custom_profile"), "custom_profile");
});

test("model role alias helper resolves supported profile names only", () => {
  // `strong_model`, `secondary_model`, `main_agent`, and
  // `secondary_model` all resolve to the canonical `secondary_model`.
  assert.equal(resolveModelRoleAlias("strong_model"), "secondary_model");
  assert.equal(resolveModelRoleAlias("secondary_model"), "secondary_model");
  assert.equal(resolveModelRoleAlias("main_agent"), "secondary_model");
  assert.equal(resolveModelRoleAlias("fast_model"), undefined);
  assert.equal(resolveModelRoleAlias("secondary_model"), "secondary_model");
  assert.equal(resolveModelRoleAlias("unknown_profile"), undefined);
});

test("OpenAI-compatible mapper converts internal tool schemas and omits JSON mode when tools are present", () => {
  const payload = mapGenerateRequestToLiteLLM(
    {
      role: "secondary_model",
      messages: [{ role: "user", content: "read a file" }],
      responseFormat: "json",
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    },
    profile("minimax"),
  );

  assert.deepEqual(payload.tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal("response_format" in payload, true);
  assert.equal(payload.response_format, undefined);
});

function profile(provider: string, promptCache?: { enabled: boolean; minContentChars?: number }): ResolvedModelProfile {
  return {
    provider,
    model: "model",
    profileName: "default_model",
    role: "secondary_model",
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
    ...(promptCache ? { defaultParams: { promptCache } } : {}),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
