import test from "node:test";
import assert from "node:assert/strict";

import { ModelCapabilitiesRegistry, DEFAULT_MODEL_CAPABILITIES } from "../../../src/adaptive/model-capabilities.js";

test("ModelCapabilitiesRegistry defaults to no visual", () => {
  const r = new ModelCapabilitiesRegistry();
  assert.equal(r.isVisualSupported(), false);
  assert.equal(r.isToolUseSupported(), true);
  assert.equal(r.isParallelToolUseSupported(), true);
});

test("ModelCapabilitiesRegistry respects explicit capabilities", () => {
  const r = new ModelCapabilitiesRegistry({
    capabilities: { imageInput: true, videoInput: false, toolUse: true, streaming: true, parallelToolUse: false, detectedAt: "2026-01-01T00:00:00Z", source: "explicit" },
  });
  assert.equal(r.isVisualSupported(), true);
  assert.equal(r.isParallelToolUseSupported(), false);
});

test("ModelCapabilitiesRegistry.refresh merges probe results", async () => {
  const r = new ModelCapabilitiesRegistry({
    probe: async () => ({ imageInput: true, videoInput: true }),
  });
  const c = await r.refresh();
  assert.equal(c.imageInput, true);
  assert.equal(c.videoInput, true);
  assert.equal(c.source, "probe");
});

test("ModelCapabilitiesRegistry keeps default when probe throws", async () => {
  const r = new ModelCapabilitiesRegistry({
    probe: async () => { throw new Error("nope"); },
  });
  const c = await r.refresh();
  assert.equal(c.imageInput, false);
  assert.equal(c.source, "default");
});

test("DEFAULT_MODEL_CAPABILITIES is JSON-serializable and tool-use capable", () => {
  assert.equal(DEFAULT_MODEL_CAPABILITIES.toolUse, true);
  assert.equal(DEFAULT_MODEL_CAPABILITIES.imageInput, false);
});
