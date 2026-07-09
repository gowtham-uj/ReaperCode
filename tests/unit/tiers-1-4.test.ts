/**
 * Tests for T1-T4 OMP layers in context-engineering-wiring.
 *
 * - T1 idle compaction: scheduler + global slot
 * - T2 incomplete recovery: stopReason === "length" detection
 * - T3 handoff: smaller-context prompt when enabled
 * - T4 snapcompact: image-cluster collapse hook
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyConfigToTunables, getContextTunables } from "../../src/config/config-tunables.js";
import { createContextEngineeringHooks } from "../../src/runtime/context-engineering-wiring.js";

const capturedEvents: any[] = [];
function resetEvents() { capturedEvents.length = 0; return capturedEvents; }
const capturingTrajectoryLogger = {
  write: async (e: any) => { capturedEvents.push(e); },
};


function loadFreshConfig() {
  const cfg = {
    contextManagement: {
      shakeEnabled: true,
      fullSummaryEnabled: true,
      idleEnabled: true,
      idleThresholdTokens: 1000,
      idleTimeoutSeconds: 60,
      incompleteRecoveryEnabled: true,
      handoffEnabled: false,
      snapcompactEnabled: false,
      modelPromotionEnabled: false,
      modelPromotionTargetRole: null,
    },
    models: {
      default_model: { model: "MiniMax-M3", capabilities: { maxContextTokens: 32_768 } },
    },
    runtimeTunables: {},
  };
  applyConfigToTunables(cfg as any);
}

test("T2: incomplete recovery fires when stopReason === 'length' AND shouldCompact", async () => {
  resetEvents();
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const runId = "r-t2-test";
  // Pre-clear the global slot
  delete (globalThis as any)[`${runId}::incomplete-recovery`];
  // Build messages > threshold
  const messages: any[] = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ role: "assistant", content: "x".repeat(2_000), tool_calls: [{ id: `t${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: "x".repeat(200) });
  }
  // softCap = 5000 → threshold ~ 4250; messages should exceed
  // softCap = 5000 → shouldCompact tokensAfterShake / softCap > 0
  // softCap - max(16K, 750) = 5000 - 750 = 4250
  // tokensUsed = ~10K, shouldCompact true
  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    modelResponse: { stop_reason: "length" },
    messages,
    softCap: 5000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const slot = (globalThis as any)[`${runId}::incomplete-recovery`];
  assert.ok(slot !== undefined, "incomplete-recovery slot should be set");
  assert.equal(slot.stopReason, "length");
  assert.ok(typeof slot.tokensUsed === "number");
  // Cleanup
  delete (globalThis as any)[`${runId}::incomplete-recovery`];
});

test("T2: incomplete recovery does NOT fire when stopReason !== 'length'", async () => {
  resetEvents();
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const runId = "r-t2-notlength";
  delete (globalThis as any)[`${runId}::incomplete-recovery`];
  const messages: any[] = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ role: "assistant", content: "x".repeat(2_000), tool_calls: [{ id: `t${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: "x".repeat(200) });
  }
  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    modelResponse: { stop_reason: "stop" },
    messages,
    softCap: 5000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const slot = (globalThis as any)[`${runId}::incomplete-recovery`];
  assert.equal(slot, undefined, "slot must NOT be set when stopReason is not 'length'");
});

test("T1: idle scheduler creates a setTimeout when tokens exceed threshold", async () => {
  resetEvents();
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const runId = "r-t1-schedule";
  const idleKey = `${runId}::idle-compaction-timer`;
  delete (globalThis as any)[idleKey];
  delete (globalThis as any)[`${runId}::idle-compaction`];
  // Build messages that exceed 1000 tokens
  const messages: any[] = [];
  for (let i = 0; i < 5; i += 1) {
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: "x".repeat(1_000) });
  }
  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    modelResponse: { stop_reason: "stop" },
    messages,
    softCap: 100_000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const timer = (globalThis as any)[idleKey];
  assert.ok(timer !== undefined, "idle-compaction-timer should be scheduled");
  // Cleanup: clear the timer
  if (timer && typeof timer.unref === "function") clearTimeout(timer);
  delete (globalThis as any)[idleKey];
});

test("T1: idle scheduler does NOT run when idleEnabled is false", async () => {
  resetEvents();
  const cfg = {
    contextManagement: {
      idleEnabled: false,
      idleThresholdTokens: 1000,
      idleTimeoutSeconds: 60,
    },
    runtimeTunables: {},
  };
  applyConfigToTunables(cfg as any);
  const ctx = createContextEngineeringHooks();
  const runId = "r-t1-disabled";
  delete (globalThis as any)[`${runId}::idle-compaction-timer`];
  const messages: any[] = [{ role: "tool", tool_call_id: "t0", content: "x".repeat(2_000) }];
  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    modelResponse: { stop_reason: "stop" },
    messages,
    softCap: 100_000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const timer = (globalThis as any)[`${runId}::idle-compaction-timer`];
  assert.equal(timer, undefined, "no timer when idleEnabled is false");
});

test("T4: snapcompact fires in onBeforeModelCall when images cluster", async () => {
  resetEvents();
  const cfg = {
    contextManagement: {
      snapcompactEnabled: true,
      fullSummaryEnabled: true,
      idleEnabled: false,
      modelPromotionEnabled: false,
      modelPromotionTargetRole: null,
    },
    runtimeTunables: {},
  };
  applyConfigToTunables(cfg as any);
  const ctx = createContextEngineeringHooks();
  const runId = "r-t4-snap";
  // Build a live conversation with 4 consecutive image blocks
  const img = (i: number) => ({
    role: "user",
    content: [{ type: "text", text: "x".repeat(500) }, { type: "image_url", image_url: { url: `i${i}` } }],
  });
  const messages: any[] = [img(0), img(1), img(2), img(3)];
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 100_000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const snapEvent = capturedEvents.find((e) => e.kind === "snapcompact");
  assert.ok(snapEvent, "snapcompact event should fire");
  assert.ok(snapEvent.collapsed_images >= 3, "should collapse at least 3 images");
});

test("T4: snapcompact is inert when no images in conversation", async () => {
  resetEvents();
  const cfg = {
    contextManagement: {
      snapcompactEnabled: true,
      fullSummaryEnabled: true,
      idleEnabled: false,
      modelPromotionEnabled: false,
      modelPromotionTargetRole: null,
    },
    runtimeTunables: {},
  };
  applyConfigToTunables(cfg as any);
  const ctx = createContextEngineeringHooks();
  const runId = "r-t4-noimg";
  const messages: any[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 100_000,
    trajectoryLogger: capturingTrajectoryLogger,
  });
  const snapEvent = capturedEvents.find((e) => e.kind === "snapcompact");
  assert.equal(snapEvent, undefined, "snapcompact must not fire without images");
});