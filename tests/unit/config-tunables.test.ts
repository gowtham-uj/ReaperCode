import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConfigToTunables,
  getBashTunables,
  getBgTunables,
  getContextTunables,
  getEngineTunables,
  getRetryTunables,
  getTunables,
} from "../../src/config/config-tunables.js";
import { buildStarterConfig } from "../../src/config/starter-config.js";
import { parseReaperConfig } from "../../src/config/model-config.js";

function loadStarter(): ReturnType<typeof parseReaperConfig> {
  return parseReaperConfig(buildStarterConfig());
}

test("applyConfigToTunables populates the cache from the config", () => {
  const cfg = loadStarter();
  applyConfigToTunables(cfg);
  const all = getTunables();
  // Starter-config defaults flow through.
  assert.equal(all.bash.defaultTimeoutMs, 600_000);
  assert.equal(all.bash.idleTimeoutMs, 5_000);
  assert.equal(all.bg.termGraceMs, 5_000);
  assert.equal(all.engine.permissionMode, "yolo");
  assert.equal(all.engine.strictCompletionGate, true);
  assert.equal(all.retry.maxRetries, 3);
});

test("applyConfigToTunables is idempotent and accepts overrides", () => {
  const cfg = loadStarter();
  applyConfigToTunables(cfg);
  // Mutate, reapply.
  cfg.runtimeTunables.bashIdleTimeoutMs = 9_999;
  applyConfigToTunables(cfg);
  assert.equal(getBashTunables().idleTimeoutMs, 9_999);
});

test("get<Group>Tunables returns the expected slices", () => {
  const cfg = loadStarter();
  applyConfigToTunables(cfg);
  const bash = getBashTunables();
  assert.equal(typeof bash.defaultTimeoutMs, "number");
  assert.equal(typeof bash.maxOutputBytes, "number");
  const bg = getBgTunables();
  assert.equal(typeof bg.termGraceMs, "number");
  const engine = getEngineTunables();
  assert.equal(typeof engine.permissionMode, "string");
  const retry = getRetryTunables();
  assert.equal(typeof retry.maxRetries, "number");
});

test("engine tunables also drive secrets-aware lookup at module import time", () => {
  // Just verify the cache is populated after apply — proxies/lazy getters
  // on existing modules (e.g. BASH_INPUT_DEFAULTS) read through this same
  // cache.
  const cfg = loadStarter();
  applyConfigToTunables(cfg);
  assert.equal(getBashTunables().persistThresholdChars, 30_000);
});

test("getContextTunables populates all 21-layer cache fields from config", () => {
  const cfg = loadStarter();
  // Mutate one field before apply so we can verify cache reflects user
  // config, not just defaults.
  (cfg.contextManagement as { timeMicrocompactGapMs?: number }).timeMicrocompactGapMs = 12_345;
  applyConfigToTunables(cfg);
  const cm = getContextTunables();
  // Sanity: structure has every layer field.
  assert.equal(typeof cm.softCap, "number");
  assert.equal(typeof cm.timeMicrocompactGapMs, "number");
  assert.equal(typeof cm.fullSummaryEnabled, "boolean");
  assert.equal(typeof cm.shakeTriggerPct, "number");
  assert.equal(typeof cm.bashHeadTailEnabled, "boolean");
  // Overrides propagated through.
  assert.equal(cm.timeMicrocompactGapMs, 12_345);
});

test("getContextTunables defaults: every layer is on by default", () => {
  const cfg = loadStarter();
  applyConfigToTunables(cfg);
  const cm = getContextTunables();
  // Every *Enabled flag must default to true so the wiring runs by default.
  assert.equal(cm.timeMicrocompactEnabled, true, "time-microcompact must default on");
  assert.equal(cm.fullSummaryEnabled, true, "full-summary must default on");
  assert.equal(cm.bashHeadTailEnabled, true, "bash head+tail must default on");
  assert.equal(cm.shakeEnabled, true, "shake must default on");
  assert.equal(cm.modelPromotionEnabled, true, "#21 promote context model must default on");
});
