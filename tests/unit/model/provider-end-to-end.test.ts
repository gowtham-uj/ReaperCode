import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "reaper-e2e-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { PROVIDER_CATALOG } = await import("../../../src/model/provider/catalog.js");
for (const provider of PROVIDER_CATALOG) {
  for (const envVar of provider.envVars ?? [provider.envVar]) delete process.env[envVar];
}
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { loadOnboarding, clearOnboarding, hasAnyAuth, SUPPORTED_PROVIDERS } =
  await import("../../../src/model/provider-onboarding.js");
const { buildProvider, autoDetectProvider } =
  await import("../../../src/model/provider/registry.js");

test("e2e: onboarding and runtime expose the complete catalog without inventing auth", () => {
  assert.ok(PROVIDER_CATALOG.length > 200);
  assert.equal(SUPPORTED_PROVIDERS.length, PROVIDER_CATALOG.length);
  assert.equal(autoDetectProvider(), undefined);
  assert.equal(hasAnyAuth(), false);
  assert.equal(loadOnboarding(), null);
});

test("e2e: known providers require authentication before a runtime client is built", () => {
  assert.throws(
    () => buildProvider({ providerId: "openai", role: "default_model" }),
    /requires one of OPENAI_API_KEY/,
  );
  assert.throws(
    () => buildProvider({ providerId: "not-a-provider", role: "default_model" }),
    /unknown provider/,
  );
});

test("e2e: clearing onboarding remains safe with the full catalog", () => {
  clearOnboarding();
  assert.equal(loadOnboarding(), null);
});

test("teardown", () => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
