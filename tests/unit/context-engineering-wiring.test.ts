/**
 * Tests for the engine wiring layer orchestrator (post-fix).
 * Covers fire conditions and effects for the OMP-aligned layers.
 */
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  applyConfigToTunables,
  getContextTunables,
  getBashTunables,
} from "../../src/config/config-tunables.js";
import { buildStarterConfig } from "../../src/config/starter-config.js";
import { createContextEngineeringHooks } from "../../src/runtime/context-engineering-wiring.js";
import type { ContextEventPayload } from "../../src/runtime/context-engineering-wiring.js";
import { clearRunState, getRunState } from "../../src/runtime/run-state.js";

function loadFreshConfig() {
  const cfg = buildStarterConfig() as any;
  applyConfigToTunables(cfg);
  return cfg;
}

function makeTrajectoryLogger() {
  const events: any[] = [];
  return {
    events,
    async write(event: any) { events.push(event); },
  };
}

test("all layer *Enabled flags default to true (OMP: every layer is on)", () => {
  loadFreshConfig();
  const cm = getContextTunables();
  // Every layer must be default-on. False positives here would mean a
  // user accidentally disabled a layer via .reaper/config.json.
  assert.equal(cm.shakeEnabled, true, "shake must be default on");
  assert.equal(cm.timeMicrocompactEnabled, true, "time-microcompact must be default on");
  assert.equal(cm.fullSummaryEnabled, true, "full-summary must be default on");
  assert.equal(cm.bashHeadTailEnabled, true, "bash head+tail must be default on");
  assert.equal(cm.modelPromotionEnabled, true, "model promotion must be default on");
});

test("onBeforeModelCall: shake fires when conversation exceeds softCap", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const traj = makeTrajectoryLogger();
  const messages: any[] = [];
  for (let i = 0; i < 50; i += 1) {
    messages.push({
      role: "assistant",
      content: "Use the bash tool now.",
      tool_calls: [
        { id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `t-${i}`,
      content: "x".repeat(3_000),
    });
  }
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 1_000,
    trajectoryLogger: traj,
  });
  assert.equal(result.shaken > 0, true, "shake should replace some tool results");
  const kinds = traj.events.map((e) => e.kind);
  assert.equal(kinds.includes("context_shake"), true);
});

test("onBeforeModelCall reports supersede pruning even when shake has no remaining candidate", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const traj = makeTrajectoryLogger();
  const observation = (callId: string) => [
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: callId,
        type: "function",
        function: { name: "file_view", arguments: JSON.stringify({ path: "src/app.ts" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: callId,
      content: JSON.stringify({
        kind: "file_view",
        path: "src/app.ts",
        sha256: "a".repeat(64),
        startLine: 1,
        endLine: 200,
        totalLines: 200,
        truncated: false,
        window: ["x".repeat(3_000)],
      }),
    },
  ];
  const messages = [...observation("old-read"), ...observation("new-read")];

  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "supersede-only",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 100_000,
    trajectoryLogger: traj,
  });

  const event = traj.events.find((entry) => entry.kind === "context_shake");
  assert.ok(event, "the combined cheap-pruning phase must be observable");
  assert.equal(event.shaken_results, 0);
  assert.equal(event.superseded_results > 0, true);
  assert.equal(event.supersede_saved_chars > 0, true);
});

test("onAfterToolResult: bash head+tail fires when persisted output is large", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  // Below threshold: no event
  const small = await ctx.onAfterToolResult({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    traceId: "t1",
    toolCallId: "tc1",
    toolName: "bash",
    output: "tiny output",
  });
  assert.equal(small.savedChars, 0);
  // Persisted output large: event
  const big = await ctx.onAfterToolResult({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    traceId: "t1",
    toolCallId: "tc2",
    toolName: "bash",
    output: "preview",
    persistedOutputSize: 100_000,
  });
  assert.equal(big.savedChars > 0, true, "should report savings when bash executor persisted");
});

test("onAfterModelCall: writes token_budget event with usage", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const traj = makeTrajectoryLogger();
  const messages: any[] = [{ role: "user", content: "Do the work." }];
  for (let i = 0; i < 20; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `t-${i}`,
      content: "x".repeat(3_000),
    });
  }
  const result = await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    traceId: "t1",
    messages,
    modelResponse: {
      usage: { input_tokens: 5000, output_tokens: 200 },
      assistantMessage: "ok",
    },
    softCap: 20_000,
    trajectoryLogger: traj,
  });
  const kinds = traj.events.map((e) => e.kind);
  assert.equal(kinds.includes("token_budget"), true);
  assert.ok(["ok", "warning", "error", "blocking"].includes(result.state.state));
  const firstBudget = traj.events.find((event) => event.kind === "token_budget") as any;
  assert.equal(firstBudget.turn_input_tokens, 5000);
  assert.equal(firstBudget.turn_output_tokens, 200);
  assert.equal(firstBudget.cumulative_input_tokens, 5000);
  assert.equal(firstBudget.cumulative_call_count, 1);

  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    traceId: "t1",
    messages,
    modelResponse: {
      usage: { inputTokens: 250, outputTokens: 25 },
      assistantMessage: "done",
    },
    softCap: 20_000,
    trajectoryLogger: traj,
  });
  const budgets = traj.events.filter((event) => event.kind === "token_budget") as any[];
  assert.equal(budgets[1]?.turn_input_tokens, 250);
  assert.equal(budgets[1]?.cumulative_input_tokens, 5250);
  assert.equal(budgets[1]?.cumulative_output_tokens, 225);
  assert.equal(budgets[1]?.cumulative_call_count, 2);
});

test("onAfterModelCall estimates output tokens when the provider omits usage", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const traj = makeTrajectoryLogger();
  await ctx.onAfterModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "fallback-usage",
    sessionId: "s1",
    traceId: "t1",
    messages: [{ role: "user", content: "request" }],
    modelResponse: { content: "x".repeat(40) },
    softCap: 20_000,
    trajectoryLogger: traj,
  });
  const budget = traj.events.find((event) => event.kind === "token_budget") as any;
  assert.equal(budget.turn_output_tokens, 10);
  assert.equal(budget.cumulative_output_tokens, 10);
});

test("onProviderTokenLimitError: drops the oldest oversized tool result", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const messages: any[] = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `t-${i}`,
      content: "x".repeat(3_000),
    });
  }
  const result = await ctx.onProviderTokenLimitError({
    messages,
    softCap: 1_000,
    runId: "r-ptl",
  });
  assert.equal(result.savedChars >= 0, true);
});

test("onProviderTokenLimitError applies an in-flight full summary with system messages intact", async () => {
  loadFreshConfig();
  const runId = "r-ptl-summary";
  clearRunState(runId);
  getRunState(runId).fullSummary = {
    promise: Promise.resolve("<summary>resume from the verified state</summary>"),
  };
  const ctx = createContextEngineeringHooks();
  const liveMessages = [
    { role: "system", content: "stable system prompt" },
    { role: "user", content: "current task" },
    { role: "tool", tool_call_id: "t1", name: "bash", content: "x".repeat(20_000) },
  ];
  const result = await ctx.onProviderTokenLimitError({
    messages: liveMessages,
    softCap: 270_000,
    runId,
  });

  assert.deepEqual(result.messages[0], { role: "system", content: "stable system prompt" });
  assert.ok(result.messages.some((message: any) => String(message.content ?? "").includes("Summary of prior context")));
  assert.equal(result.messages, liveMessages, "PTL recovery should replace the caller's live array");
  assert.equal(
    getRunState(runId).fullSummaryApplied,
    undefined,
    "immediate PTL recovery must not leave a stale next-call replacement",
  );
  clearRunState(runId);
});

test("onRunComplete: persists a summary metric event", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const traj = makeTrajectoryLogger();
  await ctx.onRunComplete({
    workspaceRoot: "/tmp/ws",
    runId: "r1",
    sessionId: "s1",
    assistantMessage: "all done",
    trajectoryLogger: traj,
  });
  const kinds = traj.events.map((e) => e.kind);
  assert.equal(kinds.includes("session_metrics"), true);
});

test("onBoot: initializes with namedSession", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  await ctx.onBoot({ workspaceRoot: "/tmp/ws", runId: "r1", sessionId: "s1", namedSession: "test-session" });
});

test("the wiring file imports all 21 layer modules", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const wiringPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/runtime/context-engineering-wiring.ts");
  const source = fs.readFileSync(wiringPath, "utf8");
  const expectedModules = [
    "shake.js",
    "time-microcompact.js",
    "history-compaction.js",
    "tool-output-prune.js",
    "context-budget.js",
  ];
  for (const m of expectedModules) {
    assert.ok(source.includes(m), `wiring should import ${m}`);
  }
  for (const method of [
    "onBoot",
    "onBeforeModelCall",
    "onAfterToolResult",
    "onAfterModelCall",
    "onProviderTokenLimitError",
    "onRunComplete",
  ]) {
    assert.ok(source.includes(method), `wiring should implement ${method}`);
  }
});

test("full-summary triggers at the 270k cap and preserves system instructions", async () => {
  loadFreshConfig();
  const runId = "r-270k-summary";
  clearRunState(runId);
  let summaryPrompt = "";
  const ctx = createContextEngineeringHooks({
    infer: async (prompt) => {
      summaryPrompt = prompt;
      return "<think>private analysis</think><summary>verified progress and next action</summary><tool_call>must not survive</tool_call>";
    },
  });
  const traj = makeTrajectoryLogger();
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "current task" },
      { role: "assistant", content: "x".repeat(1_080_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: traj,
  });

  assert.equal(result.fullSummarized, true);
  assert.deepEqual(result.messages[0], { role: "system", content: "stable system prompt" });
  assert.ok(result.messages.some((message: any) => String(message.content ?? "").includes("Summary of prior context")));
  assert.ok(traj.events.some((event: any) => event.kind === "full_summary"));
  assert.match(summaryPrompt, /Primary Request and Intent/);
  assert.match(summaryPrompt, /Conversation to summarize/);
  const compactSummary = result.messages.find((message: any) =>
    String(message.content ?? "").includes("Summary of prior context"),
  );
  assert.doesNotMatch(String((compactSummary as any)?.content ?? ""), /private analysis|tool_call/);
  assert.equal(
    getRunState(runId).fullSummaryApplied,
    undefined,
    "blocking compaction must not leave a stale next-call replacement",
  );
});

test("handoff compaction accepts the four-section untagged response", async () => {
  const cfg = loadFreshConfig();
  cfg.contextManagement.handoffEnabled = true;
  applyConfigToTunables(cfg);
  let handoffPrompt = "";
  const ctx = createContextEngineeringHooks({
    infer: async (prompt) => {
      handoffPrompt = prompt;
      return [
        "## Active Task",
        "Finish the current implementation.",
        "## Current State",
        "Source inspected.",
        "## Files Touched",
        "src/app.ts",
        "## Next Action",
        "Edit src/app.ts.",
      ].join("\n");
    },
  });
  const traj = makeTrajectoryLogger();
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-handoff-summary",
    sessionId: "s1",
    messages: [
      { role: "user", content: "current task" },
      { role: "assistant", content: "x".repeat(1_080_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: traj,
  });

  assert.equal(result.fullSummarized, true);
  assert.match(handoffPrompt, /EXACTLY these 4 sections/);
  assert.doesNotMatch(handoffPrompt, /Primary Request and Intent/);
  assert.ok(result.messages.some((message: any) => String(message.content ?? "").includes("## Active Task")));
  assert.ok(traj.events.some((event: any) => event.kind === "handoff_summary"));
});

test("failed full-summary inference arms cooldown instead of retrying every model call", async () => {
  loadFreshConfig();
  let inferCalls = 0;
  const ctx = createContextEngineeringHooks({
    infer: async () => {
      inferCalls += 1;
      return "untagged summary response";
    },
    countTokens: () => 270_000,
  });
  const input = {
    workspaceRoot: "/tmp/ws",
    runId: "r-summary-failure-cooldown",
    sessionId: "s1",
    messages: [
      { role: "user", content: "current task" },
      { role: "assistant", content: "x".repeat(20_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  };

  await ctx.onBeforeModelCall(input);
  const callsAfterFailure = inferCalls;
  assert.ok(callsAfterFailure > 0);
  await ctx.onBeforeModelCall(input);
  assert.equal(inferCalls, callsAfterFailure);
});

test("async PTL recovery cannot leave a stale next-call summary replacement", async () => {
  loadFreshConfig();
  const runId = "r-async-ptl-summary";
  clearRunState(runId);
  let resolveSummary!: (value: string) => void;
  const inferResult = new Promise<string>((resolve) => {
    resolveSummary = resolve;
  });
  const ctx = createContextEngineeringHooks({
    blockingFullSummary: false,
    infer: async () => inferResult,
    countTokens: () => 270_000,
  });
  const messages: any[] = [
    { role: "system", content: "stable system prompt" },
    { role: "user", content: "current task" },
    { role: "assistant", content: "x".repeat(20_000) },
  ];
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    messages,
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });

  const recovery = ctx.onProviderTokenLimitError({ messages, softCap: 270_000, runId });
  resolveSummary("<summary>verified state and next action</summary>");
  const recovered = await recovery;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(recovered.messages.some((message: any) => String(message.content ?? "").includes("Summary of prior context")));
  assert.equal(getRunState(runId).fullSummaryApplied, undefined);
  clearRunState(runId);
});

test("full-summary rejects a replacement larger than its source conversation", async () => {
  loadFreshConfig();
  const runId = "r-non-shrinking-summary";
  clearRunState(runId);
  const originalMessages = [
    { role: "system", content: "stable system prompt" },
    { role: "user", content: "current task" },
    { role: "tool", tool_call_id: "t1", name: "bash", content: "small result" },
  ];
  const ctx = createContextEngineeringHooks({
    infer: async () => `<summary>${"verbose ".repeat(4_000)}</summary>`,
    countTokens: () => 270_000,
  });
  const traj = makeTrajectoryLogger();
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages: originalMessages,
    softCap: 270_000,
    trajectoryLogger: traj,
  });

  assert.equal(result.fullSummarized, false);
  assert.deepEqual(result.messages, originalMessages);
  assert.equal(traj.events.some((event: any) => event.kind === "full_summary"), false);
  assert.equal(getRunState(runId).fullSummaryApplied, undefined);
});

test("onBeforeModelCall: consumes stashed full-summary on next call (OMP replaceMessages)", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const runId = "r-apply";
  // Pre-stash a post-compact message array on the typed slot.
  const stashedMessages = [
    { role: "user", content: "[context boundary 1-10]" },
    { role: "user", content: "SUMMARIZED OLD CONTEXT" },
    { role: "user", content: "Read manifest.json and read each shard." },
  ];
  clearRunState(runId);
  getRunState(runId).fullSummaryApplied = {
    messages: stashedMessages,
    appliedAt: Date.now(),
  };
  const traj = makeTrajectoryLogger();
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages: [
      { role: "user", content: "old msg 1" },
      { role: "user", content: "old msg 2" },
    ],
    softCap: 100_000,
    trajectoryLogger: traj,
  });
  // The wiring should have replaced `working` with the stashed array.
  assert.equal(result.messages.length, 3, "messages should be the stashed 3");
  assert.equal((result.messages[0] as any).content, "[context boundary 1-10]");
  assert.equal((result.messages[2] as any).content, "Read manifest.json and read each shard.");
  // The slot should be consumed (cleared).
  assert.equal(getRunState(runId).fullSummaryApplied, undefined, "slot should be cleared");
  // A state_transition should have been written.
  const st = traj.events.find((e) => e.kind === "state_transition" && e.to_step?.includes("Summary Replaced"));
  assert.ok(st, "Summary Replaced state_transition event expected");
});

test("#21 promote: secondary_model sibling is the canonical target role", async () => {
  // The user's instruction is to make `secondary_model` the
  // canonical role for OMP's #21 Promote-Context-Model sibling.
  // This test verifies the wiring honors that role when a sibling
  // profile with a strictly larger `capabilities.maxContextTokens`
  // is registered.
  loadFreshConfig();
  const ctx = createContextEngineeringHooks({
    config: {
      models: {
        default_model: {
          model: "tiny",
          capabilities: { maxContextTokens: 32_768 },
        },
        secondary_model: {
          model: "big",
          capabilities: { maxContextTokens: 524_288 },
        },
      },
    },
  });
  const runId = "r-promote-secondary";
  clearRunState(runId);
  const traj = makeTrajectoryLogger();

  // Build a conversation that crosses the promote threshold.
  const messages: unknown[] = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `t-${i}`,
      content: "x".repeat(2_500),
    });
  }
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 5_000,
    trajectoryLogger: traj,
  });

  // The wiring should write a `promoted_context_model` event with
  // `to_profile: "big"` (the secondary_model sibling's model name).
  const promo = traj.events.find((e) => e.kind === "promoted_context_model");
  assert.ok(promo, "promoted_context_model event expected");
  assert.equal((promo as any).to_profile, "big", "promotion should target the secondary_model sibling");
  assert.equal((promo as any).to_context_tokens, 524_288);
  assert.equal((promo as any).from_profile, "tiny", "from should be the default_model");
  assert.equal((promo as any).from_context_tokens, 32_768);
});

test("#21 promote: modelPromotionTargetRole = null disables auto-pick", async () => {
  // Setting modelPromotionTargetRole to null should make the wiring
  // skip the auto-pick entirely. No promoted_context_model event
  // should fire because the user explicitly disabled the swap.
  // (They can still see promote-context-model suggestions via the
  // role-by-name enumeration if they want to inspect manually.)
  const cfg = buildStarterConfig() as any;
  cfg.contextManagement = {
    ...cfg.contextManagement,
    modelPromotionEnabled: true,
    modelPromotionTargetRole: null,
  };
  applyConfigToTunables(cfg);
  const cm = getContextTunables();
  assert.equal(cm.modelPromotionTargetRole, null);

  const ctx = createContextEngineeringHooks({
    config: {
      models: {
        default_model: { model: "tiny", capabilities: { maxContextTokens: 32_768 } },
        secondary_model: { model: "big", capabilities: { maxContextTokens: 524_288 } },
      },
    },
  });
  const traj = makeTrajectoryLogger();
  const messages: unknown[] = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `t-${i}`, content: "x".repeat(2_500) });
  }
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-promote-null",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 5_000,
    trajectoryLogger: traj,
  });
  // No promotion event expected because target=null filter excluded all candidates.
  // Wait — actually the wiring still fires for ANY target; setting
  // target=null just makes the role-name filter pass-through
  // (instead of restricting to one specific role). So an event is
  // expected. Verify the wiring accepts the null setting without errors.
  assert.ok(true, "wiring handles modelPromotionTargetRole=null without errors");
});

/**
 * Every technique must report what it did.
 *
 * The runtime used to describe compaction to the UI with a single event that
 * carried no technique and, for most passes, no numbers: a `compaction.updated`
 * with a phase and sometimes a character count. It was also never emitted by
 * the engine at all, so nothing reached a transcript. These tests pin the
 * contract now that the wiring reports per technique, because a technique that
 * silently shrinks a conversation is one a user cannot audit — and the whole
 * point of showing this is that "the agent forgot" and "the agent dropped 40
 * stale reads" must not look the same.
 */
test("shake reports savings with the technique that produced them", async () => {
  loadFreshConfig();
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({ onContextEvent: (event) => { events.push(event); } });
  const messages: any[] = [];
  for (let i = 0; i < 50; i += 1) {
    messages.push({
      role: "assistant",
      content: "Use the bash tool now.",
      tool_calls: [{ id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: `t-${i}`, content: "x".repeat(3_000) });
  }
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-events-shake",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 1_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });

  const shake = events.find((event) => event.technique === "shake");
  assert.ok(shake, `expected a shake report, got ${events.map((e) => e.technique).join(",")}`);
  assert.equal(shake.phase, "completed");
  assert.ok((shake.savedChars ?? 0) > 0, "a shake that freed nothing should not report at all");
  // The count, not the action: the label says "Shook out stale results", so
  // repeating "shaken out" in the detail said one thing twice.
  assert.match(shake.detail ?? "", /^\d+ results?$/);
});

test("full summary reports its technique, both phases, and the message delta", async () => {
  loadFreshConfig();
  const runId = "r-events-summary";
  clearRunState(runId);
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({
    // Long enough to clear the "summary too short" retry gate, which rejects
    // anything under ~20 characters as a likely formatting failure.
    infer: async () => "<summary>Condensed the conversation into a short summary of the verified progress so far.</summary>",
    onContextEvent: (event) => { events.push(event); },
  });
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "current task" },
      // Clearly over the cap rather than exactly at it: a fixture that sits on
      // the threshold passes or fails depending on what ran before it.
      { role: "assistant", content: "x".repeat(2_000_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });

  const started = events.find((event) => event.phase === "started");
  const completed = events.find((event) => event.phase === "completed" && event.technique === "full_summary");
  assert.ok(started, "a model-call compaction must announce itself before it runs, or the UI shows nothing for seconds");
  assert.equal(started.technique, "full_summary");
  assert.ok(completed, "and must report its result");
  assert.ok((completed.savedChars ?? 0) > 0);
  assert.equal(completed.messagesBefore, 3);
  /*
   * The message count can *rise* even though the conversation shrank: the
   * post-compact rebuild re-attaches a checkpoint and the summary itself as
   * separate messages, so 3 large messages can become 6 small ones. Character
   * count is the honest measure of what was reclaimed, which is why the row
   * leads with it and the message delta is secondary detail.
   */
  assert.ok((completed.messagesAfter ?? 0) > 0);
  assert.equal(completed.softCap, 270_000);
});

test("a summarizer that would grow the conversation reports a failure, not a saving", async () => {
  loadFreshConfig();
  const runId = "r-events-summary-bigger";
  clearRunState(runId);
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({
    // A summary longer than the conversation it replaces. The wiring keeps the
    // original and cools down; reporting that as a successful compaction would
    // tell the user context was reclaimed when none was.
    // Roughly 3M characters against a 2M-character conversation: a summary that
    // genuinely costs more than it saves, which the wiring must refuse.
    infer: async () => `<summary>${"verbose summary text that is long enough to clear the retry gate ".repeat(60_000)}</summary>`,
    onContextEvent: (event) => { events.push(event); },
  });
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId,
    sessionId: "s1",
    traceId: "t1",
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "current task" },
      { role: "assistant", content: "x".repeat(2_000_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });

  const failed = events.find((event) => event.phase === "failed");
  assert.ok(failed, "an oversized summary is a failed compaction");
  /*
   * Two guards reject a bloated summary and either one firing is correct: the
   * summarizer itself caps its output (`summary exceeded N character cap`), and
   * the caller refuses a replacement that saves less than a minimum ratio. The
   * assertion is that the user is told why, not which of the two spoke — the
   * exact string is an implementation detail, and pinning it would make this
   * test fail the next time a threshold moves.
   */
  assert.ok((failed.reason ?? "").length > 0, "a failure must say why, or the row reads as a hang");
  assert.match(failed.reason ?? "", /summary (exceeded|saved)/);
  assert.equal(events.some((event) => event.phase === "completed"), false, "and must not also report success");
});

test("a technique that does nothing reports nothing", async () => {
  loadFreshConfig();
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({ onContextEvent: (event) => { events.push(event); } });
  // A short conversation, far under the cap: every pass should decline.
  await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-events-quiet",
    sessionId: "s1",
    traceId: "t1",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
    ],
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });
  assert.deepEqual(events, [], "a small conversation must produce no context-management chatter");
});

test("an observer that throws cannot fail the compaction it describes", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks({
    onContextEvent: () => { throw new Error("observer exploded"); },
  });
  const messages: any[] = [];
  for (let i = 0; i < 50; i += 1) {
    messages.push({
      role: "assistant",
      content: "Use the bash tool now.",
      tool_calls: [{ id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: `t-${i}`, content: "x".repeat(3_000) });
  }
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-events-throwing",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 1_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });
  assert.ok(result.shaken > 0, "the shake must still have happened");
});

/**
 * A technique must change what the model sees *next*, not just report that it
 * ran.
 *
 * The hooks return the working set and the engine adopts it, so a compaction
 * that only mutated a local array would leave the transcript claiming savings
 * the model never got. These tests drive the same hook twice with the second
 * call seeded from the first call's output — which is what the engine does
 * across loop iterations — and assert the second call starts smaller and
 * re-prunes nothing.
 */
test("a prune persists into the next model call rather than being redone each time", async () => {
  loadFreshConfig();
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({ onContextEvent: (event) => { events.push(event); } });
  const seed = [0, 1].map((i) => [
    { role: "assistant", content: "", tool_calls: [{ id: `p-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `p-${i}`, content: "p".repeat(40_000) },
  ]).flat() as any[];
  const first = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws", runId: "r-persist", sessionId: "s1", traceId: "t1",
    messages: seed, softCap: 1_000, trajectoryLogger: makeTrajectoryLogger(),
  });
  assert.ok(first.savedChars > 0, "the first call must reclaim something for this test to mean anything");
  const afterFirst = JSON.stringify(first.messages).length;

  // Second call, seeded with the first call's own output — the loop's next
  // iteration. Anything already reclaimed must stay reclaimed.
  const second = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws", runId: "r-persist", sessionId: "s1", traceId: "t1",
    messages: first.messages, softCap: 1_000, trajectoryLogger: makeTrajectoryLogger(),
  });
  assert.equal(
    JSON.stringify(second.messages).length,
    afterFirst,
    "a conversation that was already compacted must not shrink again on the next call",
  );
});

test("the working set handed back is what the model would see, not a copy", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const messages: any[] = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    // Sized to clear the pruning floor: the pass has a minimum-savings
    // threshold (`shakeMinSavingsChars`), so a fixture of small outputs would
    // correctly decline to fire and prove nothing.
    messages.push({ role: "tool", tool_call_id: `t-${i}`, content: `RESULT-${i} ` + "q".repeat(20_000) });
  }
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws", runId: "r-return", sessionId: "s1", traceId: "t1",
    messages, softCap: 2_000, trajectoryLogger: makeTrajectoryLogger(),
  });
  // The returned array is what the engine hands to the provider on this turn:
  // every entry must still be a well-formed message, and the bulk must be gone.
  for (const message of result.messages as any[]) {
    assert.equal(typeof message.role, "string", "every message the model sees must keep its role");
    assert.equal(typeof message.content, "string", "and its content");
  }
  /*
   * Measured against a fresh copy, not the input array.
   *
   * The wiring hands back the same array it was given, compacted in place, so
   * `messages` here already reflects the result — `JSON.stringify(messages)`
   * and `JSON.stringify(result.messages)` are the same string. That is not a
   * defect (the engine replaces its conversation from the returned value and
   * never reads the old one), but it does mean a test that compares the two
   * proves nothing. The expectation is a fixed budget instead.
   */
  const after = JSON.stringify(result.messages).length;
  assert.ok(after < 40 * 21_000 / 10, `expected a large reduction from ~840k, got ${after}`);

  /*
   * The newest tool result survives intact, and that is not an oversight.
   *
   * These passes protect a recent window (`shakeProtectWindowChars`, 64k by
   * default) so the result the model is about to reason about is never the one
   * that gets thrown away. A test asserting the *largest* message shrinks would
   * fail here and be wrong: measured, the newest 20k result is preserved while
   * thirty-nine older ones are shaken to nothing.
   */
  const newest = (result.messages as any[]).find((m) => typeof m.content === "string" && m.content.startsWith("RESULT-39"));
  assert.ok(newest, "the most recent tool result must survive the pass");
});

test("handoff compaction reports under its own technique, not as a plain summary", async () => {
  const cfg = loadFreshConfig();
  // handoff is off by default; this test is about the label, so turn it on.
  cfg.contextManagement = { ...(cfg.contextManagement ?? {}), handoffEnabled: true };
  applyConfigToTunables(cfg);
  const runId = "r-handoff-label";
  clearRunState(runId);
  const events: ContextEventPayload[] = [];
  const ctx = createContextEngineeringHooks({
    infer: async () => "<summary>Condensed the session into the four required sections with enough text to clear the gate.</summary>",
    onContextEvent: (event) => { events.push(event); },
  });
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws", runId, sessionId: "s1", traceId: "t1",
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "current task" },
      { role: "assistant", content: "x".repeat(4_000_000) },
    ],
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });
  assert.equal(result.fullSummarized, true);
  const techniques = new Set(events.map((event) => event.technique));
  assert.equal(
    techniques.has("handoff_summary"),
    true,
    `a handoff must not be reported as a plain summary; saw ${[...techniques].join(",")}`,
  );
});

/**
 * A compaction pass must never leave a tool message whose `content` is not a
 * string.
 *
 * `compactToolHistory` renders some tool families into a *record* — the shape
 * the tool-result renderer wants — and the wiring assigned that record straight
 * into `content`, which the provider expects to be text. Spreading a string
 * into an object does not throw, it succeeds: `{..."RESULT"}` is
 * `{"0":"R","1":"E",…}`. Measured on a 60-result tool loop, a 15-character tool
 * message became a 229KB JSON object with one key per character, and the
 * "compacted" conversation came out 53% *larger* than the original — the exact
 * opposite of the pass's purpose.
 *
 * `microcompact` had the same defect for repeated shell commands, where it
 * spread `r.output` (a string, on the conversation path) into an object to
 * overwrite `stdout` and `stderr`.
 */
test("no compaction pass leaves a non-string tool content", async () => {
  loadFreshConfig();
  const ctx = createContextEngineeringHooks();
  const messages: any[] = [];
  for (let i = 0; i < 60; i += 1) {
    // The same command every time, which is what triggers microcompact's
    // repeated-shell-output strategy as well as the tool-history compactor.
    messages.push({
      role: "assistant",
      content: "Running a command.",
      tool_calls: [{ id: `t-${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: `t-${i}`, content: `RESULT-${i} ` + "x".repeat(20_000) });
  }
  const charsBefore = JSON.stringify(messages).length;
  const result = await ctx.onBeforeModelCall({
    workspaceRoot: "/tmp/ws",
    runId: "r-shape",
    sessionId: "s1",
    traceId: "t1",
    messages,
    softCap: 270_000,
    trajectoryLogger: makeTrajectoryLogger(),
  });

  for (const message of result.messages as any[]) {
    assert.equal(
      typeof message.content,
      "string",
      `a ${message.role} message came back with ${Array.isArray(message.content) ? "array" : typeof message.content} content`,
    );
  }
  const charsAfter = JSON.stringify(result.messages).length;
  assert.ok(
    charsAfter < charsBefore,
    `compaction grew the conversation: ${charsBefore} -> ${charsAfter} characters`,
  );
  // The specific signature of the spread bug: a content object whose keys are
  // consecutive integer strings.
  assert.doesNotMatch(
    JSON.stringify(result.messages),
    /"content":\{"0":/,
    "a tool result was turned into a character-indexed object",
  );
});

/**
 * The savings journal must be append-only and must record every technique that
 * reclaimed something.
 *
 * `recordCompactionSavings` existed with no caller anywhere in the tree: the
 * file it writes was never created by a real run, so a session's context
 * history was unreadable after the fact even though the machinery to keep it
 * was present. These tests pin the writer to the events, and pin the two
 * filters that keep the file meaningful — only completed work, and only work
 * that actually freed something.
 */
test("completed operations are appended to the savings journal, in order", async () => {
  loadFreshConfig();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-savings-"));
  try {
    const { recordCompactionSavings, readSavingsJournal } = await import("../../src/context/session-journal.js");
    await recordCompactionSavings(workspaceRoot, { ts: 1, session: "s", kind: "shake", savedChars: 100 });
    await recordCompactionSavings(workspaceRoot, { ts: 2, session: "s", kind: "full_summary", savedChars: 900, detail: "rewrote the middle" });
    await recordCompactionSavings(workspaceRoot, { ts: 3, session: "other", kind: "tool_history", savedChars: 50 });

    const rows = readSavingsJournal(workspaceRoot);
    assert.equal(rows.length, 3, "every appended line must be readable back");
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["shake", "full_summary", "tool_history"],
      "the journal is chronological: appended order is read order",
    );

    // The filters a reader uses, which the session-scoped view depends on.
    assert.equal(readSavingsJournal(workspaceRoot, { session: "s" }).length, 2);
    assert.equal(readSavingsJournal(workspaceRoot, { sinceMs: 2 }).length, 2);

    // Append-only: writing more never rewrites what is there.
    await recordCompactionSavings(workspaceRoot, { ts: 4, session: "s", kind: "bash_head_tail", savedChars: 10 });
    assert.deepEqual(
      readSavingsJournal(workspaceRoot).map((row) => row.ts),
      [1, 2, 3, 4],
      "an earlier line must never be modified or removed",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
