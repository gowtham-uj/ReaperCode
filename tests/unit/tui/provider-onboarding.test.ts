/**
 * provider-onboarding — round-trip tests for the first-run credential
 * store. We exercise:
 *   1. hasAnyAuth returns false when nothing is configured.
 *   2. saveOnboarding writes a 0600 file + seeds process.env.
 *   3. loadOnboarding round-trips the saved state.
 *   4. clearOnboarding wipes both the file and the seeded env var.
 *   5. seedEnvFromOnboarding idempotently seeds env from a saved file.
 *   6. resolveProviderKey prefers env over saved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force a temp HOME so we don't touch the real ~/.reaper dir during
// tests. The module captures homedir() at import time, so we have to
// set HOME before importing.
const tmpHome = mkdtempSync(join(tmpdir(), "reaper-onboarding-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  SUPPORTED_PROVIDERS,
  hasAnyAuth,
  saveOnboarding,
  loadOnboarding,
  clearOnboarding,
  seedEnvFromOnboarding,
  resolveProviderKey,
} = await import("../../../src/tui/provider-onboarding.js");

test("provider-onboarding: SUPPORTED_PROVIDERS mirrors the catalog (data-driven)", () => {
  const ids = SUPPORTED_PROVIDERS.map((p) => p.id);
  // Today: all catalog providers are exposed. Adding a vendor to
  // the catalog automatically adds it to the picker — that's the
  // whole point of Phase 1d.
  for (const required of ["anthropic", "openai", "minimax"]) {
    assert.ok(ids.includes(required), `picker is missing provider "${required}"`);
  }
  for (const p of SUPPORTED_PROVIDERS) {
    assert.ok(p.envVar.length > 0, `envVar for ${p.id} is empty`);
    assert.ok(p.baseUrl.startsWith("https://"), `baseUrl for ${p.id} not https`);
    assert.ok(p.models.length > 0, `no models listed for ${p.id}`);
  }
});

test("provider-onboarding: hasAnyAuth false on a clean home", () => {
  clearOnboarding();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(hasAnyAuth(), false);
});

test("provider-onboarding: saveOnboarding writes a 0600 file + seeds env", () => {
  clearOnboarding();
  saveOnboarding({
    provider: "minimax",
    envVar: "MINIMAX_API_KEY",
    apiKey: "sk-test-1234",
    model: "MiniMax-M3",
  });
  const path = join(tmpHome, ".reaper", "onboarding.json");
  assert.ok(existsSync(path), "onboarding.json was not created");
  const st = statSync(path);
  // 0o600 → 384 decimal; mask off type bits.
  assert.equal(st.mode & 0o777, 0o600, `expected 0600 perms, got ${(st.mode & 0o777).toString(8)}`);
  assert.equal(process.env.MINIMAX_API_KEY, "sk-test-1234", "env var was not seeded");
  assert.equal(hasAnyAuth(), true);
});

test("provider-onboarding: loadOnboarding round-trips saved state", () => {
  saveOnboarding({
    provider: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    apiKey: "ds-test-abc",
    model: "deepseek-chat",
  });
  const loaded = loadOnboarding();
  assert.ok(loaded, "loadOnboarding returned null");
  assert.equal(loaded!.provider, "deepseek");
  assert.equal(loaded!.envVar, "DEEPSEEK_API_KEY");
  assert.equal(loaded!.apiKey, "ds-test-abc");
  assert.equal(loaded!.model, "deepseek-chat");
  assert.ok(loaded!.savedAt.length > 0, "savedAt is empty");
});

test("provider-onboarding: clearOnboarding wipes file + env vars", () => {
  saveOnboarding({
    provider: "minimax",
    envVar: "MINIMAX_API_KEY",
    apiKey: "sk-test-clear",
    model: "MiniMax-M3",
  });
  assert.equal(hasAnyAuth(), true);
  clearOnboarding();
  const path = join(tmpHome, ".reaper", "onboarding.json");
  assert.equal(existsSync(path), false, "onboarding.json was not removed");
  assert.equal(process.env.MINIMAX_API_KEY, undefined, "MINIMAX_API_KEY was not unset");
  assert.equal(hasAnyAuth(), false);
});

test("provider-onboarding: seedEnvFromOnboarding seeds env from saved file", () => {
  clearOnboarding();
  delete process.env.MINIMAX_API_KEY;
  saveOnboarding({
    provider: "minimax",
    envVar: "MINIMAX_API_KEY",
    apiKey: "sk-seeded",
    model: "MiniMax-M3",
  });
  // Wipe the env var to simulate a fresh shell.
  delete process.env.MINIMAX_API_KEY;
  const result = seedEnvFromOnboarding();
  assert.ok(result, "seedEnvFromOnboarding returned null");
  assert.equal(result!.provider, "minimax");
  assert.equal(process.env.MINIMAX_API_KEY, "sk-seeded");
  // Idempotency: calling twice is a no-op.
  seedEnvFromOnboarding();
  assert.equal(process.env.MINIMAX_API_KEY, "sk-seeded");
});

test("provider-onboarding: resolveProviderKey prefers env over saved", () => {
  saveOnboarding({
    provider: "minimax",
    envVar: "MINIMAX_API_KEY",
    apiKey: "sk-saved",
    model: "MiniMax-M3",
  });
  process.env.MINIMAX_API_KEY = "sk-env";
  assert.equal(resolveProviderKey("minimax"), "sk-env");
  delete process.env.MINIMAX_API_KEY;
  // Now falls back to the saved value.
  assert.equal(resolveProviderKey("minimax"), "sk-saved");
  // Unknown provider → undefined.
  assert.equal(resolveProviderKey("not-a-real-provider" as never), undefined);
});

// Cleanup the temp HOME at the end of the run.
test("provider-onboarding: teardown", () => {
  clearOnboarding();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
