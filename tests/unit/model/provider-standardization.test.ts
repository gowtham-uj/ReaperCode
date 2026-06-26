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
});

test("buildProvider throws for unknown provider ids", () => {
  assert.throws(() => buildProvider({ providerId: "not-a-provider", role: "main_reasoner" }), /unknown provider/);
});

test("buildProvider throws for model not in catalogue", () => {
  assert.throws(
    () => buildProvider({ providerId: "openai", modelId: "gpt-none", role: "main_reasoner" }),
    /not in the openai catalogue/,
  );
});

test("resolveModelFromCatalog defaults to catalogue default model", () => {
  const model = resolveModelFromCatalog({ providerId: "anthropic", role: "main_reasoner" });
  assert.equal(model.providerId, "anthropic");
  assert.equal(model.modelId, "claude-opus-4-8");
});

test("autoDetectProvider returns undefined when no keys are set", () => {
  // None of the catalog env vars should be set in CI.
  assert.equal(autoDetectProvider(), undefined);
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
});
