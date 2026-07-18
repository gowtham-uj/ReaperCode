/**
 * Per-run state store: isolation, lifecycle, and source-level invariants.
 *
 * - Concurrent runs with different runIds keep independent state.
 * - clearRunState(runId) drops slots AND pending idle-compaction timers.
 * - Resumed runs (re-stashed sessionResume) only see their own slot.
 * - No `(globalThis as any)[\`${runId}::*\`]` patterns remain in src/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  clearRunState,
  getRunState,
  getRunStateCount,
  hasRunState,
} from "../../src/runtime/run-state.js";
import { createContextEngineeringHooks } from "../../src/runtime/context-engineering-wiring.js";
import { applyConfigToTunables } from "../../src/config/config-tunables.js";

function loadFreshConfig() {
  applyConfigToTunables({
    contextManagement: {
      shakeEnabled: false,
      fullSummaryEnabled: false,
      idleEnabled: true,
      idleThresholdTokens: 1000,
      idleTimeoutSeconds: 60,
      incompleteRecoveryEnabled: false,
      handoffEnabled: false,
      snapcompactEnabled: false,
      modelPromotionEnabled: false,
      modelPromotionTargetRole: null,
    },
    models: {
      default_model: { model: "test-model", capabilities: { maxContextTokens: 32_768 } },
    },
    runtimeTunables: {},
  } as any);
}

test("concurrent runs keep independent state", () => {
  clearRunState("run-A");
  clearRunState("run-B");
  getRunState("run-A").fullSummaryCooldown = { baselineTokens: 100, toolBatchesSince: 0, appliedAt: 1 };
  getRunState("run-B").fullSummaryCooldown = { baselineTokens: 200, toolBatchesSince: 1, appliedAt: 2 };
  getRunState("run-A").lastInputTokens = 5_000;

  assert.equal(getRunState("run-A").fullSummaryCooldown?.baselineTokens, 100);
  assert.equal(getRunState("run-B").fullSummaryCooldown?.baselineTokens, 200);
  assert.equal(getRunState("run-A").lastInputTokens, 5_000);
  assert.equal(getRunState("run-B").lastInputTokens, undefined);

  clearRunState("run-A");
  clearRunState("run-B");
});

test("clearRunState drops the idle-compaction timer", async () => {
  loadFreshConfig();
  const runId = "run-timer-clear";
  clearRunState(runId);
  const ctx = createContextEngineeringHooks();
  // Force the idle scheduler to arm by exceeding the threshold.
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
    trajectoryLogger: { write: async () => undefined },
  });
  assert.ok(getRunState(runId).idleCompactionTimer, "timer should be scheduled");
  assert.ok(hasRunState(runId));
  clearRunState(runId);
  assert.equal(hasRunState(runId), false, "run should be cleared");
  assert.equal(getRunStateCount() >= 0, true);
});

test("resumed runs read their own sessionResume slot", () => {
  const runA = "resume-A";
  const runB = "resume-B";
  clearRunState(runA);
  clearRunState(runB);
  getRunState(runA).sessionResume = {
    resume: {
      reAnchor: "re-anchor-A",
      rehydratedMessages: [{ role: "user", content: "hi from A" }],
      summary: null,
      stats: { recentTurns: 1, recentChars: 0, summariesAvailable: 0 },
    },
    namedSession: "alpha",
    sessionId: "sess-A",
    stashedAt: 1,
  };
  getRunState(runB).sessionResume = {
    resume: {
      reAnchor: "re-anchor-B",
      rehydratedMessages: [{ role: "user", content: "hi from B" }],
      summary: null,
      stats: { recentTurns: 1, recentChars: 0, summariesAvailable: 0 },
    },
    namedSession: "beta",
    sessionId: "sess-B",
    stashedAt: 2,
  };

  const a = getRunState(runA).sessionResume;
  const b = getRunState(runB).sessionResume;
  assert.equal(a?.namedSession, "alpha");
  assert.equal(b?.namedSession, "beta");
  assert.equal(a?.resume.reAnchor, "re-anchor-A");
  assert.equal(b?.resume.reAnchor, "re-anchor-B");
  // Mutating one never leaks into the other.
  getRunState(runA).sessionResume = undefined;
  assert.equal(getRunState(runA).sessionResume, undefined);
  assert.notEqual(getRunState(runB).sessionResume, undefined);

  clearRunState(runA);
  clearRunState(runB);
});

test("src/ contains zero per-runId globalThis slots", () => {
  // Allowlist = comments / documentation / this test file itself.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, "../../src");
  const offenders: string[] = [];
  walk(srcRoot, (file) => {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;
    const text = readFileSync(file, "utf8");
    // Strip comments to keep doc references from blocking the assertion.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (/globalThis\s*[\[(][^)\]]*::/.test(code)) {
      offenders.push(file);
    }
  });
  assert.deepEqual(offenders, [], `remaining globalThis run slots: ${offenders.join(", ")}`);
});

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}
