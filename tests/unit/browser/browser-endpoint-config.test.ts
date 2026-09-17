/**
 * Raw Chrome is not a configurable endpoint.
 *
 * The runtime refuses it before connecting, but a config that names it should
 * fail at load with a message about the field rather than at the first browse.
 * These tests pin that, and pin that the Steel value still loads, so the guard
 * cannot be loosened by a later edit to the default.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ReaperConfigSchema } from "../../../src/config/model-config.js";
import { createValidConfig } from "../../fixtures/phase0.js";

function withCdpUrl(url: string): unknown {
  const config = createValidConfig() as unknown as {
    runtimeTunables: Record<string, unknown>;
  };
  config.runtimeTunables["browserCdpUrl"] = url;
  return config;
}

test("Steel's endpoint loads", () => {
  const parsed = ReaperConfigSchema.safeParse(withCdpUrl("ws://127.0.0.1:3000"));
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("raw Chrome's port is refused at load, naming the field", () => {
  for (const url of ["http://127.0.0.1:9222", "ws://127.0.0.1:9223"]) {
    const parsed = ReaperConfigSchema.safeParse(withCdpUrl(url));
    assert.equal(parsed.success, false, `${url} should be refused`);
    if (parsed.success) continue;
    const issue = parsed.error.issues.find((entry) => entry.path.join(".").includes("browserCdpUrl"));
    assert.ok(issue, `the refusal should name browserCdpUrl, got ${JSON.stringify(parsed.error.issues)}`);
    assert.match(issue.message, /Steel/);
  }
});

test("a Steel on another host or port still loads", () => {
  // The refusal is specific to Chrome, not to "not 127.0.0.1:3000": a remote
  // self-host or Steel Cloud names a different host and must load.
  const parsed = ReaperConfigSchema.safeParse(withCdpUrl("ws://steel.internal:8080"));
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});
