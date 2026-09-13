import test from "node:test";
import assert from "node:assert/strict";

import { checkProviderProfileReadiness } from "../../src/model/preflight.js";
import { isSelectionRunnable } from "../../src/model/provider/integration-registry.js";
import type { ResolvedModelProfile } from "../../src/model/types.js";
import { ConfiguredModelGateway } from "../../src/model/gateway.js";

const profile: ResolvedModelProfile = {
  profileName: "secondary_model",
  role: "secondary_model",
  provider: "test-provider",
  model: "test-model",
  apiKeyEnv: "TEST_PROVIDER_KEY",
  apiBase: "https://provider.example/v1",
  capabilities: {
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
  },
};

test("provider preflight catches missing credentials before a model call", () => {
  const result = checkProviderProfileReadiness(profile, {});
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /TEST_PROVIDER_KEY/);
});

test("provider preflight accepts a configured profile", () => {
  assert.equal(checkProviderProfileReadiness(profile, { TEST_PROVIDER_KEY: "configured" }).ok, true);
});

/*
 * Transport coverage lives in `AiSdkProviderClient.buildSdk` now, and it asks
 * `isSelectionRunnable` for the verdict — the same call the model picker uses
 * to decide whether to grey a row out. These tests cover that verdict at the
 * boundary the client actually consumes, so the two cannot drift apart.
 */

test("a catalog model whose transport is installed is runnable", () => {
  // Read from the real pinned catalog rather than a fixture, so this also
  // catches the loader table drifting away from the catalog it claims to
  // serve. DeepInfra is the provider the live smoke tests run against.
  const verdict = isSelectionRunnable("deepinfra", "zai-org/GLM-5.3-Flash");
  assert.equal(verdict.runnable, true, verdict.reason);
  assert.equal(verdict.transportNpm, "@ai-sdk/deepinfra");
  assert.equal(verdict.catalogManaged, true);
});

test("a provider outside the catalog is not refused for lacking a transport", () => {
  /*
   * The legacy wire families — direct Anthropic, an explicit OpenAI-compatible
   * endpoint, a local LiteLLM — are not Models.dev entries. Their routing
   * belongs to the provider registry, which raises its own error for anything
   * it cannot resolve. Refusing them would break every existing configuration
   * that does not go through the catalog, and they are the majority of what
   * the integration tests exercise.
   */
  const verdict = isSelectionRunnable("test", "static-json");
  assert.equal(verdict.runnable, true, verdict.reason);
  assert.equal(verdict.catalogManaged, false, "an unmanaged provider must be reported as such");
});

test("a catalog provider is refused when its transport is missing", async () => {
  // The registry is asked directly with a catalog whose model names a package
  // this build does not ship, which is what a future refresh could introduce.
  const { ModelsDevCatalogService } = await import("../../src/model/provider/models-dev-catalog.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");

  const home = mkdtempSync(nodePath.join(tmpdir(), "reaper-preflight-coverage-"));
  const snapshotPath = nodePath.join(home, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify({
    futureland: {
      id: "futureland",
      name: "Futureland",
      env: ["FUTURELAND_API_KEY"],
      npm: "@ai-sdk/invented-by-a-future-refresh",
      api: "https://futureland.example.test/v1",
      models: {
        "future-model": {
          id: "future-model",
          name: "Future Model",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 8_000, output: 1_000 },
        },
      },
    },
  }));
  try {
    const service = new ModelsDevCatalogService({ home, snapshotPath });
    const verdict = isSelectionRunnable("futureland", "future-model", service);
    assert.equal(verdict.runnable, false);
    assert.equal(verdict.catalogManaged, true);
    assert.equal(verdict.transportNpm, "@ai-sdk/invented-by-a-future-refresh");
    assert.match(verdict.reason ?? "", /@ai-sdk\/invented-by-a-future-refresh/);
    assert.match(verdict.reason ?? "", /not installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider preflight failure routes generation to a configured fallback", async () => {
  const calls: string[] = [];
  const configuredProfile = {
    provider: profile.provider,
    model: profile.model,
    apiBase: profile.apiBase,
    apiKeyEnv: profile.apiKeyEnv,
    capabilities: profile.capabilities,
  };
  const gateway = new ConfiguredModelGateway(
    {
      models: {
        default_model: {
          ...configuredProfile,
          fallbackProfile: "fast_reasoner",
        },
        fast_reasoner: {
          ...configuredProfile,
          model: "fallback-model",
          apiKeyEnv: undefined,
        },
      },
    },
    {
      async generate(request, resolved) {
        calls.push(resolved.model);
        return {
          role: request.role,
          profileName: resolved.profileName,
          provider: resolved.provider,
          model: resolved.model,
          content: "ready",
          raw: {},
        };
      },
      async *stream() {
        yield { type: "message_end" as const };
      },
      async embed(request, resolved) {
        return {
          role: request.role,
          profileName: resolved.profileName,
          provider: resolved.provider,
          model: resolved.model,
          vectors: [],
          raw: {},
        };
      },
    },
  );

  const result = await gateway.generate({ role: "default_model", messages: [{ role: "user", content: "test" }] });
  assert.equal(result.model, "fallback-model");
  assert.deepEqual(calls, ["fallback-model"]);
});
