import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MODELS_DEV_SNAPSHOT_METADATA,
  ModelsDevCatalogService,
} from "../../../src/model/provider/models-dev-catalog.js";
import { ProviderCredentialStore } from "../../../src/config/provider-credentials.js";
import { UNSUPPORTED_PROVIDERS } from "../../../src/model/provider-registry.js";
import { ProviderIntegrationRegistry } from "../../../src/model/provider/integration-registry.js";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../../../src/app-server/connection.js";

const snapshotPath = path.resolve("/work/src/model/provider/models-dev.json");

/**
 * A service reading the pinned snapshot and nothing else.
 *
 * It has to be handed a private `home`. The service falls back to the real
 * cache directory at `~/.cache/reaper/models.json`, and it prefers that file
 * over the snapshot whenever it parses — so on a machine that has ever synced
 * the catalog from the network, a service constructed without `home` answers
 * from a *newer* catalog and the pinned counts below do not match. That is the
 * behaviour we want at runtime (a fresher catalog is better) and exactly what
 * we do not want in a test asserting the pinned one. These tests were reading
 * the developer's cache and passing or failing according to what that machine
 * happened to have downloaded.
 */
function pinnedService(): ModelsDevCatalogService {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-models-pinned-"));
  cleanupDirs.push(home);
  return new ModelsDevCatalogService({ home, snapshotPath });
}

/** Homes handed to `pinnedService`, removed once the file has finished. */
const cleanupDirs: string[] = [];
test.after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

test("the pinned Models.dev snapshot exposes the complete OpenCode catalog", () => {
  const service = pinnedService();
  const status = service.status();
  assert.equal(status.source, "snapshot");
  assert.equal(status.providerCount, MODELS_DEV_SNAPSHOT_METADATA.providerCount);
  assert.equal(status.modelCount, MODELS_DEV_SNAPSHOT_METADATA.modelCount);
  assert.ok(service.provider("anthropic"));
  assert.ok(service.provider("openai"));
  assert.ok(service.provider("openrouter"));
  assert.ok(service.provider("amazon-bedrock"));
});

test("model results are searchable and bounded instead of returning the entire catalog", () => {
  const service = pinnedService();
  const first = service.listModels({ providerId: "openrouter", limit: 25 });
  assert.equal(first.data.length, 25);
  assert.ok(first.nextCursor);
  assert.ok(first.total > first.data.length);

  const reasoning = service.listModels({
    providerId: "openrouter",
    query: "qwen",
    reasoning: true,
    limit: 10,
  });
  assert.ok(reasoning.data.length > 0);
  assert.ok(reasoning.data.every((model) => model.reasoning));
  assert.ok(reasoning.data.every((model) => `${model.id} ${model.name}`.toLowerCase().includes("qwen")));
});

test("provider summaries stay lightweight and every catalog provider has API-key fallback", () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-models-summary-"));
  try {
    const service = new ModelsDevCatalogService({ home, snapshotPath });
    const registry = new ProviderIntegrationRegistry(
      undefined,
      new ProviderCredentialStore({ home }),
      service,
    );
    const providers = registry.list();
    assert.equal(providers.length, MODELS_DEV_SNAPSHOT_METADATA.providerCount);
    assert.ok(providers.every((provider) => provider.modelCount >= 0));
    assert.ok(providers.every((provider) => provider.authMethods.some((method) => method.type === "api")));
    assert.ok(providers.every((provider) => !("models" in provider) && !("modelDetails" in provider)));
    assert.ok(Buffer.byteLength(JSON.stringify({ providers })) < 512 * 1024);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider summaries and the largest model page stay inside the gateway message limit", () => {
  /*
   * The reason the catalog was split into `provider/list` +
   * `provider/models/list` in the first place: the whole thing is ~4.5 MiB,
   * roughly four and a half times what the app-server will let a client send,
   * so returning it in one payload is not merely slow, it is rejected.
   *
   * These assertions are what keep the split honest. A future field added to
   * the summary shape is invisible in a unit test of that field but obvious
   * here, and the failure lands in CI rather than in a user's browser as a
   * closed socket.
   */
  const home = mkdtempSync(path.join(tmpdir(), "reaper-models-payload-"));
  try {
    const service = new ModelsDevCatalogService({ home, snapshotPath });
    const registry = new ProviderIntegrationRegistry(
      undefined,
      new ProviderCredentialStore({ home }),
      service,
    );

    const providers = registry.list();
    const summaryBytes = Buffer.byteLength(JSON.stringify({ providers }));
    assert.ok(
      summaryBytes < DEFAULT_MAX_MESSAGE_BYTES,
      `provider/list returned ${summaryBytes} bytes, over the ${DEFAULT_MAX_MESSAGE_BYTES}-byte limit`,
    );
    // Not merely under the limit but comfortably so: the browser must be able
    // to hold a second copy in flight without approaching the ceiling.
    assert.ok(summaryBytes < DEFAULT_MAX_MESSAGE_BYTES / 4, `provider/list is ${summaryBytes} bytes, expected a lightweight summary`);

    // The worst page the RPC can be asked for: the largest provider at the
    // maximum limit the schema accepts, which is 200.
    let worst = { providerId: "", bytes: 0 };
    for (const provider of providers) {
      const page = registry.listModels({ providerId: provider.providerId, limit: 200 });
      const bytes = Buffer.byteLength(JSON.stringify(page));
      if (bytes > worst.bytes) worst = { providerId: provider.providerId, bytes };
    }
    assert.ok(worst.bytes > 0, "expected at least one provider to have models");
    assert.ok(
      worst.bytes < DEFAULT_MAX_MESSAGE_BYTES,
      `the largest model page (${worst.providerId}, ${worst.bytes} bytes) exceeds the ${DEFAULT_MAX_MESSAGE_BYTES}-byte limit`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every listed model carries a transport verdict", () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-models-runnable-"));
  try {
    const service = new ModelsDevCatalogService({ home, snapshotPath });
    const registry = new ProviderIntegrationRegistry(
      undefined,
      new ProviderCredentialStore({ home }),
      service,
    );
    const providers = registry.list();
    assert.ok(providers.every((provider) => typeof provider.runnable === "boolean"));
    /*
     * Every transport identity in the pinned snapshot has a loader, so this
     * build should be able to serve all of it. A false here means a catalog
     * entry outran the loader table.
     *
     * Excluding the deliberately unsupported providers: they are absent from
     * the catalog binding on purpose (see UNSUPPORTED_PROVIDERS in
     * provider-registry.ts), so they have no transport and no runnable model,
     * and this assertion would otherwise demand that a provider the build
     * removed be served.
     */
    const unrunnable = providers
      .filter((provider) => !UNSUPPORTED_PROVIDERS.has(provider.providerId))
      .filter((provider) => !provider.runnable)
      .map((p) => p.providerId);
    assert.deepEqual(unrunnable, [], `providers with no servable model: ${unrunnable.join(", ")}`);

    // And the excluded ones really are excluded, rather than merely unrunnable.
    for (const provider of providers) {
      if (UNSUPPORTED_PROVIDERS.has(provider.providerId)) {
        assert.equal(provider.runnable, false, `${provider.providerId} is excluded and must not report as runnable`);
      }
    }

    const page = registry.listModels({ providerId: "deepinfra", limit: 5 });
    assert.ok(page.data.length > 0);
    for (const model of page.data) {
      assert.equal(model.runnable, true, `${model.id} should be runnable`);
      assert.ok(model.transportNpm, `${model.id} must name the transport its verdict is about`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed refresh preserves the last valid snapshot", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-models-refresh-"));
  const localSnapshot = path.join(root, "snapshot.json");
  writeFileSync(localSnapshot, JSON.stringify({
    fixture: {
      id: "fixture",
      name: "Fixture",
      env: ["FIXTURE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://fixture.example.test/v1",
      models: {
        model: {
          id: "model",
          name: "Model",
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
    const service = new ModelsDevCatalogService({
      home: root,
      snapshotPath: localSnapshot,
      fetch: (async () => new Response("{not json", { status: 200 })) as typeof fetch,
    });
    await assert.rejects(() => service.refresh(true));
    assert.equal(service.status().providerCount, 1);
    assert.equal(service.provider("fixture")?.models.model?.id, "model");
    assert.ok(service.status().refreshError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
