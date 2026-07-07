import test from "node:test";
import assert from "node:assert/strict";
import { buildProvider, resolveProvider, resolveModelFromCatalog, autoDetectProvider } from "../../../src/model/provider/registry.js";
import { findProviderDescriptor, PROVIDER_CATALOG } from "../../../src/model/provider/catalog.js";

test("catalog only exposes openai-chat and anthropic-messages families", () => {
  for (const desc of PROVIDER_CATALOG) {
    assert.ok(
      desc.sdkFamily === "openai-chat" || desc.sdkFamily === "anthropic-messages",
      `provider ${desc.id} uses unsupported family ${desc.sdkFamily}`,
    );
  }
});

test("findProviderDescriptor returns descriptors for the two supported families", () => {
  const anthro = findProviderDescriptor("anthropic");
  assert.equal(anthro?.sdkFamily, "anthropic-messages");
  const openai = findProviderDescriptor("openai");
  assert.equal(openai?.sdkFamily, "openai-chat");
  const nuralwatt = findProviderDescriptor("nuralwatt");
  assert.equal(nuralwatt?.sdkFamily, "openai-chat");
  assert.equal(nuralwatt?.baseUrl, "https://api.neuralwatt.com/v1");
  assert.equal(nuralwatt?.envVar, "NURALWATT_API_KEY");
  assert.equal(nuralwatt?.defaultModel, "kimi-k2.7-code");
  const nuralwatt2 = findProviderDescriptor("nuralwatt2");
  assert.equal(nuralwatt2?.sdkFamily, "openai-chat");
  assert.equal(nuralwatt2?.baseUrl, "https://api.neuralwatt.com/v1");
  assert.equal(nuralwatt2?.envVar, "NURALWATT_API_KEY2");
  assert.equal(nuralwatt2?.defaultModel, "kimi-k2.7-code");
});

test("buildProvider throws for unknown provider ids", () => {
  assert.throws(() => buildProvider({ providerId: "not-a-provider", role: "secondary_model" }), /unknown provider/);
});

test("buildProvider throws for model not in catalogue", () => {
  assert.throws(
    () => buildProvider({ providerId: "openai", modelId: "gpt-none", role: "secondary_model" }),
    /not in the openai catalogue/,
  );
});

test("resolveModelFromCatalog defaults to catalogue default model", () => {
  const model = resolveModelFromCatalog({ providerId: "anthropic", role: "secondary_model" });
  assert.equal(model.providerId, "anthropic");
  assert.equal(model.modelId, "claude-opus-4-8");
});

test("autoDetectProvider returns undefined when no keys are set", () => {
  // None of the catalog env vars should be set in CI.
  const saved: Record<string, string | undefined> = {};
  for (const provider of PROVIDER_CATALOG) {
    saved[provider.envVar] = process.env[provider.envVar];
    delete process.env[provider.envVar];
  }
  saved.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    assert.equal(autoDetectProvider(), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test("resolveProvider reads API key from env var for supported families", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-test-anthropic" }, () => {
    const descriptor = findProviderDescriptor("anthropic")!;
    const resolved = resolveProvider(descriptor);
    assert.equal(resolved.apiKey, "sk-test-anthropic");
    assert.equal(resolved.descriptor.sdkFamily, "anthropic-messages");
  });
  withEnv({ OPENAI_API_KEY: "sk-test-openai" }, () => {
    const descriptor = findProviderDescriptor("openai")!;
    const resolved = resolveProvider(descriptor);
    assert.equal(resolved.apiKey, "sk-test-openai");
    assert.equal(resolved.descriptor.sdkFamily, "openai-chat");
  });
  withEnv({ NURALWATT_API_KEY: "test-nuralwatt" }, () => {
    const descriptor = findProviderDescriptor("nuralwatt")!;
    const resolved = resolveProvider(descriptor);
    assert.equal(resolved.apiKey, "test-nuralwatt");
    assert.equal(resolved.descriptor.sdkFamily, "openai-chat");
  });
  withEnv({ NURALWATT_API_KEY2: "test-nuralwatt2" }, () => {
    const descriptor = findProviderDescriptor("nuralwatt2")!;
    const resolved = resolveProvider(descriptor);
    assert.equal(resolved.apiKey, "test-nuralwatt2");
    assert.equal(resolved.descriptor.sdkFamily, "openai-chat");
  });
});
