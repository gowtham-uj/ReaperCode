import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ModelsDevCatalogService } from "../../../src/model/provider/models-dev-catalog.js";
import {
  effectiveTransportNpm,
  hasTransport,
  isTransportInstalled,
  loadTransport,
  OPENAI_COMPATIBLE_TRANSPORT,
  supportedTransports,
} from "../../../src/model/provider/transports.js";
import { resolveTransport } from "../../../src/model/provider/transport-options.js";
import { UNSUPPORTED_PROVIDERS } from "../../../src/model/provider-registry.js";

const catalog = new ModelsDevCatalogService({ home: "/nonexistent-reaper-transport-coverage" });

/** Every npm identity the pinned snapshot advertises, provider or model level. */
function catalogTransports(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const provider of catalog.providers()) {
    const names = new Set<string>();
    if (provider.npm) names.add(provider.npm);
    for (const model of Object.values(provider.models)) {
      if (model.provider?.npm) names.add(model.provider.npm);
    }
    for (const name of names) {
      const providers = out.get(name) ?? [];
      providers.push(provider.id);
      out.set(name, providers);
    }
  }
  return out;
}

test("every catalog transport identity has an installed loader", () => {
  /*
   * Excluding a provider is deliberate and has to be excluded here too, or this
   * test demands a loader for a transport the build intentionally dropped.
   * `UNSUPPORTED_PROVIDERS` is the same set the catalog binding reads, so the
   * two cannot drift: removing a provider there fails this test until the
   * provider is named in the set.
   */
  const missing: string[] = [];
  for (const [npm, providers] of catalogTransports()) {
    if (providers.every((id) => UNSUPPORTED_PROVIDERS.has(id))) continue;
    if (!hasTransport(npm)) missing.push(`${npm} (${providers.slice(0, 3).join(", ")})`);
  }
  assert.deepEqual(missing, [], `Catalog transports without a loader:\n${missing.join("\n")}`);
});

test("every installed loader imports its package", async () => {
  for (const npm of supportedTransports()) {
    const factory = await loadTransport(npm);
    assert.equal(typeof factory, "function", `${npm} did not resolve to a factory`);
  }
});

test("catalog providers without a declared transport fall back to OpenAI-compatible", () => {
  const providers = catalog.providers().filter((provider) => !provider.npm);
  for (const provider of providers) {
    assert.ok(provider.api, `Provider ${provider.id} has neither an npm package nor an API base URL`);
  }
});

test("OpenAI-compatible providers resolve a base URL and a provider name", () => {
  const provider = catalog.provider("deepinfra");
  assert.ok(provider);
  const resolution = resolveTransport({
    providerId: "openai-compatible-fixture",
    modelId: "some-model",
    npm: "@ai-sdk/openai-compatible",
    apiBase: "https://example.invalid/v1",
    apiKey: "fixture-key",
    env: {},
  });
  assert.equal(resolution.options.name, "openai-compatible-fixture");
  assert.equal(resolution.options.baseURL, "https://example.invalid/v1");
  assert.equal(resolution.options.apiKey, "fixture-key");
});

test("OpenAI-compatible providers without a base URL are rejected", () => {
  assert.throws(
    () => resolveTransport({
      providerId: "no-base-url",
      modelId: "m",
      npm: "@ai-sdk/openai-compatible",
      env: {},
    }),
    /no API base URL/,
  );
});

test("credentials come from the call, then catalog env vars, never a hardcoded global", () => {
  const fromCall = resolveTransport({
    providerId: "deepinfra",
    modelId: "zai-org/GLM-5.3-Flash",
    npm: "@ai-sdk/deepinfra",
    apiKey: "per-call-key",
    envVars: ["DEEPINFRA_API_KEY"],
    env: { DEEPINFRA_API_KEY: "env-key" },
  });
  assert.equal(fromCall.options.apiKey, "per-call-key");

  const fromEnv = resolveTransport({
    providerId: "deepinfra",
    modelId: "zai-org/GLM-5.3-Flash",
    npm: "@ai-sdk/deepinfra",
    envVars: ["DEEPINFRA_API_KEY"],
    env: { DEEPINFRA_API_KEY: "env-key" },
  });
  assert.equal(fromEnv.options.apiKey, "env-key");

  const unconfigured = resolveTransport({
    providerId: "deepinfra",
    modelId: "zai-org/GLM-5.3-Flash",
    npm: "@ai-sdk/deepinfra",
    envVars: ["DEEPINFRA_API_KEY"],
    env: {},
  });
  assert.equal(unconfigured.options.apiKey, undefined);
});

test("Azure requires a resource name or an explicit base URL", () => {
  assert.throws(
    () => resolveTransport({ providerId: "azure", modelId: "gpt-5", npm: "@ai-sdk/azure", env: {} }),
    /resource name/,
  );
  const resolved = resolveTransport({
    providerId: "azure",
    modelId: "gpt-5",
    npm: "@ai-sdk/azure",
    metadata: { resourceName: "contoso" },
    env: {},
  });
  assert.equal(resolved.options.resourceName, "contoso");
});

test("Bedrock applies cross-region inference prefixes only where required", () => {
  const usEast = resolveTransport({
    providerId: "amazon-bedrock",
    modelId: "anthropic.claude-sonnet-4-5",
    npm: "@ai-sdk/amazon-bedrock",
    metadata: { region: "us-east-1" },
    env: {},
  });
  const captured: string[] = [];
  const sdk = { languageModel: (id: string) => { captured.push(id); return id; } };
  usEast.selectModel(sdk, "anthropic.claude-sonnet-4-5");
  assert.deepEqual(captured, ["us.anthropic.claude-sonnet-4-5"]);

  captured.length = 0;
  usEast.selectModel(sdk, "global.anthropic.claude-sonnet-4-5");
  assert.deepEqual(captured, ["global.anthropic.claude-sonnet-4-5"], "already-prefixed ids pass through");
});

test("OpenAI and xAI prefer the Responses API when the SDK exposes one", () => {
  const openai = resolveTransport({ providerId: "openai", modelId: "gpt-5", npm: "@ai-sdk/openai", env: {} });
  const sdk = {
    languageModel: () => "chat-completions",
    responses: () => "responses",
  };
  assert.equal(openai.selectModel(sdk, "gpt-5"), "responses");
  assert.equal(openai.selectModel({ languageModel: () => "chat-only" }, "gpt-5"), "chat-only");
});

test("Cloudflare gateways require their account and gateway identifiers", () => {
  assert.throws(
    () => resolveTransport({
      providerId: "cloudflare-ai-gateway",
      modelId: "m",
      npm: "ai-gateway-provider",
      metadata: { accountId: "acct" },
      env: {},
    }),
    /gateway id/,
  );
  const resolved = resolveTransport({
    providerId: "cloudflare-ai-gateway",
    modelId: "m",
    npm: "ai-gateway-provider",
    metadata: { accountId: "acct", gatewayId: "gw" },
    env: {},
  });
  assert.equal(resolved.options.accountId, "acct");
  assert.equal(resolved.options.gateway, "gw");
});

test("every model in the pinned snapshot is marked runnable", () => {
  /*
   * The other half of "a model is runnable only when its loader is installed".
   * The coverage table proves the loaders exist; this proves the verdict the
   * browser and the preflight actually read agrees with it, for all 7,000-odd
   * models rather than a sample. A model whose transport is missing must come
   * back non-runnable — never silently runnable and then unfixable mid-turn.
   */
  let models = 0;
  const broken: string[] = [];
  for (const provider of catalog.providers()) {
    // Deliberately unsupported providers are not required to be runnable; see
    // the note in the transport-coverage test above.
    if (UNSUPPORTED_PROVIDERS.has(provider.id)) continue;
    for (const model of Object.values(provider.models)) {
      models += 1;
      const context = { providerNpm: provider.npm, modelNpm: model.provider?.npm };
      const verdict = isTransportInstalled(context);
      const expected = hasTransport(effectiveTransportNpm(context));
      if (verdict !== expected) {
        broken.push(`${provider.id}/${model.id}: ${verdict} != ${expected}`);
      }
      if (!verdict) broken.push(`${provider.id}/${model.id} needs ${effectiveTransportNpm(context)}`);
    }
  }
  assert.ok(models > 1000, `expected the full catalog, saw ${models} models`);
  assert.deepEqual(broken, [], `Models this build cannot serve:\n${broken.slice(0, 20).join("\n")}`);
});

test("a provider with no npm package resolves through the OpenAI-compatible fallback", () => {
  // Not an edge case to tolerate — most of the catalog's custom endpoints are
  // exactly this shape, and treating them as "no transport" would mark a large
  // slice of working providers unrunnable.
  assert.equal(effectiveTransportNpm({}), OPENAI_COMPATIBLE_TRANSPORT);
  assert.equal(isTransportInstalled({}), true);
});

test("a model-level npm override wins over the provider's", () => {
  assert.equal(
    effectiveTransportNpm({ providerNpm: "@ai-sdk/openai", modelNpm: "@ai-sdk/amazon-bedrock" }),
    "@ai-sdk/amazon-bedrock",
  );
});

test("an unknown transport is reported unrunnable rather than assumed to work", () => {
  // The catalog is refreshed from the network; a future entry can name a
  // package this build has never heard of. Claiming it runs would produce a
  // turn that dies importing a missing module.
  assert.equal(hasTransport("@ai-sdk/invented-by-a-future-refresh"), false);
  assert.equal(
    isTransportInstalled({ providerNpm: "@ai-sdk/invented-by-a-future-refresh" }),
    false,
  );
});

test("the checked-in coverage table matches the pinned snapshot", async () => {
  const { transportCoverage } = await import("../../../scripts/sync-transport-coverage.js");
  const table = readFileSync(
    new URL("../../../src/model/provider/TRANSPORTS.md", import.meta.url),
    "utf8",
  );
  // The module-level `catalog` above, not a bare `new ModelsDevCatalogService()`.
  // A service with no `home` reads the real `~/.cache/reaper/models.json` and
  // prefers it over the snapshot, so a developer who has ever synced the
  // catalog would compare a newer catalog against a table generated from the
  // pinned one and see every row go stale at once.
  for (const row of transportCoverage(catalog)) {
    assert.ok(
      table.includes(`| \`${row.npm}\` | installed | ${row.providers.length} | ${row.modelCount} |`),
      `TRANSPORTS.md is stale for ${row.npm}; run \`npm run sync:transports\``,
    );
  }
});
