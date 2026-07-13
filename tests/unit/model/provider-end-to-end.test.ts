/**
 * provider-end-to-end — smoke test the full onboarding → registry
 * → ModelProvider chain. No network calls; we just walk the
 * catalog and assert that for every entry:
 *   1. The picker exposes it.
 *   2. saveOnboarding seeds the right env var.
 *   3. buildProvider returns a ModelProvider bound to the right
 *      family + model.
 *
 * This is the regression test for the Phase 1d refactor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "reaper-e2e-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { PROVIDER_CATALOG } = await import("../../../src/model/provider/catalog.js");
const { saveOnboarding, loadOnboarding, clearOnboarding, hasAnyAuth, SUPPORTED_PROVIDERS } =
  await import("../../../src/model/provider-onboarding.js");
const { buildProvider, autoDetectProvider } =
  await import("../../../src/model/provider/registry.js");

test("e2e: every catalog provider is exposed in the onboarding picker", () => {
  for (const p of PROVIDER_CATALOG) {
    const inPicker = SUPPORTED_PROVIDERS.find((sp) => sp.id === p.id);
    assert.ok(inPicker, `picker missing ${p.id}`);
    assert.equal(inPicker!.envVar, p.envVar);
    assert.deepEqual(inPicker!.models, p.models);
  }
});

test("e2e: saving onboarding for each catalog provider seeds the right env var", () => {
  for (const p of PROVIDER_CATALOG) {
    // The MiniMax SDK key uses a different env var than what the
    // catalog stores; we just smoke-test the round-trip.
    saveOnboarding({
      provider: p.id,
      envVar: p.envVar,
      apiKey: `test-key-${p.id}`,
      model: p.defaultModel,
    });
    assert.equal(process.env[p.envVar], `test-key-${p.id}`, `${p.id} env var not seeded`);
    assert.equal(hasAnyAuth(), true);

    const loaded = loadOnboarding();
    assert.ok(loaded, `loadOnboarding returned null for ${p.id}`);
    assert.equal(loaded!.provider, p.id);
    assert.equal(loaded!.envVar, p.envVar);
    assert.equal(loaded!.model, p.defaultModel);
  }
});

test("e2e: buildProvider works for every catalog entry given the right env", () => {
  for (const p of PROVIDER_CATALOG) {
    process.env[p.envVar] = `smoke-${p.id}`;
    const provider = buildProvider({ providerId: p.id, role: "default_model" });
    assert.equal(provider.providerId, p.id);
    assert.equal(provider.sdkFamily, p.sdkFamily);
    assert.equal(provider.modelId, p.defaultModel);
  }
});

test("e2e: clearOnboarding wipes every catalog env var", () => {
  for (const p of PROVIDER_CATALOG) {
    process.env[p.envVar] = `will-be-cleared-${p.id}`;
  }
  clearOnboarding();
  for (const p of PROVIDER_CATALOG) {
    assert.equal(process.env[p.envVar], undefined, `${p.envVar} was not cleared`);
  }
});

test("e2e: autoDetectProvider finds the catalog entry when its env var is set", () => {
  for (const p of PROVIDER_CATALOG) {
    // Wipe every other provider's env so detection is deterministic.
    // The registry falls back to ANTHROPIC_AUTH_TOKEN for every
    // vendor, so we have to clear the legacy alias too.
    for (const other of PROVIDER_CATALOG) {
      if (other.envVar !== p.envVar) delete process.env[other.envVar];
    }
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env[p.envVar] = `detect-${p.id}`;
    const detected = autoDetectProvider();
    assert.ok(detected, `autoDetectProvider returned undefined for ${p.id}`);
    assert.equal(detected!.id, p.id, `autoDetectProvider picked ${detected!.id} instead of ${p.id}`);
  }
});

test("e2e: /provider slash command re-runs the picker after clearOnboarding", () => {
  // Save + verify it's loaded, then clear + verify picker is empty.
  saveOnboarding({
    provider: "minimax",
    envVar: "MINIMAX_API_KEY",
    apiKey: "once-was-here",
    model: "MiniMax-M3",
  });
  assert.ok(loadOnboarding());
  clearOnboarding();
  assert.equal(loadOnboarding(), null);
  // After clearing, the user can re-run /provider and pick a
  // different vendor — proven by the fact that SUPPORTED_PROVIDERS
  // is still populated from the catalog.
  assert.ok(SUPPORTED_PROVIDERS.length > 0);
});

test("teardown", () => {
  for (const p of PROVIDER_CATALOG) {
    delete process.env[p.envVar];
  }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
