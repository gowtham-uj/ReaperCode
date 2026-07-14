import test from "node:test";
import assert from "node:assert/strict";

import {
  tryFullSummarization,
  buildPostCompactMessages,
  FULL_SUMMARY_DEFAULTS,
  runSummariser,
  extractSummary,
} from "../../src/context/full-summary.js";
import {
  COMPACTION_CHECKPOINT_MESSAGE_NAME,
  parseCompactionCheckpoint,
  buildCompactionCheckpoint,
  renderCompactionCheckpoint,
} from "../../src/context/compaction-checkpoint.js";

test("extractSummary parses the canonical <summary> block", () => {
  const text = "<analysis>thinking</analysis><summary>1. intent\n2. work</summary>";
  assert.equal(extractSummary(text), "1. intent\n2. work");
});

test("extractSummary fallback strips common provider reasoning tags", () => {
  const text = "<think>x</think><analysis>y</analysis><reasoning>z</reasoning>plain summary text here";
  assert.equal(extractSummary(text), "plain summary text here");
});

test("compaction checkpoints redact secrets before re-injection", () => {
  const fakeGithubToken = `ghp_${"B".repeat(36)}`;
  const checkpoint = buildCompactionCheckpoint(
    `1. Primary Request and Intent\nKeep ${fakeGithubToken} available.\n9. Optional Next Step\nUse ${fakeGithubToken}.`,
    [{ role: "user", content: `Deploy with ${fakeGithubToken}. This token must survive.` }],
  );
  const rendered = renderCompactionCheckpoint(checkpoint);
  assert.doesNotMatch(rendered, new RegExp(fakeGithubToken));
  assert.match(rendered, /\[REDACTED:github-token\]/);
  const parsed = parseCompactionCheckpoint({
    role: "user",
    name: COMPACTION_CHECKPOINT_MESSAGE_NAME,
    content: rendered,
  });
  assert.ok(parsed);
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(fakeGithubToken));
});

test("accepted summaries redact secrets before replacing live context", async () => {
  const fakeGithubToken = `ghp_${"C".repeat(36)}`;
  const conversation = [
    { role: "user", content: `Repair the service with ${fakeGithubToken}.` },
    { role: "tool", tool_call_id: "large-output", name: "bash", content: "x".repeat(50_000) },
  ];
  const result = await tryFullSummarization(conversation, {
    softCap: 1_000,
    infer: async () => `<summary>1. Primary Request and Intent\nUse ${fakeGithubToken}.\n9. Optional Next Step\nContinue safely.</summary>`,
  });
  assert.equal(result?.performed, true);
  assert.doesNotMatch(result?.summary ?? "", new RegExp(fakeGithubToken));
  assert.match(result?.summary ?? "", /\[REDACTED:github-token\]/);
});

test("tryFullSummarization returns null when conversation is below threshold", async () => {
  const result = await tryFullSummarization(
    [{ role: "user", content: "small prompt" }],
    { softCap: 1_000_000, infer: async () => "ignored" },
  );
  assert.equal(result, null);
});

test("tryFullSummarization builds a compact conversation with a durable checkpoint", async () => {
  const longConversation: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }> = [];
  for (let i = 0; i < 50; i += 1) {
    longConversation.push({ role: "user", content: `user message ${i} `.repeat(40) });
    longConversation.push({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "file_view", arguments: JSON.stringify({ path: `src/file-${i}.ts` }) } }],
    });
    longConversation.push({ role: "tool", tool_call_id: `t-${i}`, name: "file_view", content: "x".repeat(800) });
  }
  const fakeSummary = "<summary>1. intent\n2. files\n3. work\n4. errors\n5. pending</summary>";
  const result = await tryFullSummarization(longConversation, {
    softCap: 25_000,
    infer: async () => fakeSummary,
    maxFilesToRestore: 3,
  });
  assert.ok(result, "result should be defined");
  assert.equal(result.performed, true);
  const messages = buildPostCompactMessages(fakeSummary, longConversation, { softCap: 25_000, maxFilesToRestore: 3 });
  assert.ok(messages.length >= 5, `expected >=5 messages, got ${messages.length}`);
  assert.match(messages[0]?.content ?? "", /\[Reaper context boundary\]/);
  assert.equal(messages[1]?.name, COMPACTION_CHECKPOINT_MESSAGE_NAME);
  assert.ok(parseCompactionCheckpoint(messages[1]!));
  assert.match(messages[2]?.content ?? "", /1\. intent/);
  assert.match(messages[3]?.content ?? "", /Post-compact re-anchor/);
  const reattach = messages[3]?.content ?? "";
  const matches = reattach.match(/^\s+\d+\.\s+\S+$/gm) ?? [];
  assert.equal(matches.length, 3);
  // Saved chars must be positive.
  assert.ok(result.savedChars > 0);
});

test("tryFullSummarization retries on PTL by truncating head", async () => {
  const longConversation: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }> = [];
  for (let i = 0; i < 100; i += 1) {
    longConversation.push({ role: "user", content: "x".repeat(2000) });
    longConversation.push({ role: "tool", tool_call_id: `t-${i}`, name: "file_view", content: "x".repeat(2000) });
  }
  let attempts = 0;
  const result = await tryFullSummarization(longConversation, {
    softCap: 50_000,
    infer: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("context length exceeded"), { status: 400 });
      }
      return "<summary>1. intent\n2. files\n3. work\n4. errors\n5. pending</summary>";
    },
    maxPtlRetries: 3,
  });
  assert.ok(result, "result should be defined");
  assert.equal(result?.performed, true);
  assert.ok((result?.ptlDrops ?? 0) >= 1, `expected at least 1 PTL drop, got ${result?.ptlDrops}`);
});

test("tryFullSummarization preserves complete context on a formatting retry", async () => {
  const marker = "DURABLE_FACT_MUST_SURVIVE";
  const longConversation = [
    { role: "user", content: `Preserve this acceptance criterion: ${marker}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "retry-output",
        function: { name: "bash", arguments: JSON.stringify({ cmd: "generate-output" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "retry-output",
      name: "bash",
      content: "x".repeat(200_000),
    },
  ];
  const prompts: string[] = [];
  const result = await tryFullSummarization(longConversation, {
    softCap: 50_000,
    infer: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? "untagged summary"
        : `<summary>${marker} preserved after formatting retry</summary>`;
    },
    maxPtlRetries: 2,
  });
  assert.equal(result?.performed, true);
  assert.equal(result?.ptlDrops, 0);
  assert.equal(prompts.length, 2);
  assert.equal(prompts.every((prompt) => prompt.includes(marker)), true);
  assert.match(result?.summary ?? "", new RegExp(marker));
});

test("tryFullSummarization rejects an untagged failure message", async () => {
  const longConversation: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }> = [];
  for (let i = 0; i < 100; i += 1) {
    longConversation.push({ role: "tool", tool_call_id: `t-${i}`, name: "file_view", content: "x".repeat(2000) });
  }
  const result = await tryFullSummarization(longConversation, {
    softCap: 50_000,
    infer: async () => "I cannot summarize this conversation because the input is too long.",
    maxPtlRetries: 2,
  });
  assert.ok(result, "result should be defined even on failure");
  assert.equal(result?.performed, false);
  assert.match(result?.summary ?? "", /failed/);
});

test("FULL_SUMMARY_DEFAULTS exposes the cc-haha constants", () => {
  assert.equal(FULL_SUMMARY_DEFAULTS.maxFilesToRestore, 5);
  assert.equal(FULL_SUMMARY_DEFAULTS.maxPtlRetries, 3);
});

test("runSummariser builds a prompt that contains BASE_COMPACT_PROMPT and the conversation", async () => {
  let capturedPrompt = "";
  await runSummariser({
    conversation: JSON.stringify({ role: "user", content: "hi" }),
    infer: async (p) => { capturedPrompt = p; return "<summary>ok</summary>"; },
  });
  assert.match(capturedPrompt, /Primary Request and Intent/);
  assert.match(capturedPrompt, /All user messages/);
  assert.match(capturedPrompt, /Respond with text only/);
  assert.match(capturedPrompt, /Conversation to summarize/);
});

test("runSummariser includes the prior checkpoint and delta-summary contract", async () => {
  let capturedPrompt = "";
  const priorCheckpoint = {
    schemaVersion: 1 as const,
    epoch: 3,
    originalTask: "Keep CODEWORD-ALPHA verbatim.",
    currentTask: "Implement the next delta.",
    goldenFacts: ["CODEWORD-ALPHA"],
    completedSteps: ["Initial migration passed"],
    decisions: ["Use deterministic compaction"],
    failures: [],
    files: [{ path: "src/a.ts", sha256: "a".repeat(64), startLine: 1, endLine: 20 }],
    nextAction: "Run the focused test",
    summarySha256: "b".repeat(64),
  };
  await runSummariser({
    conversation: JSON.stringify({ role: "tool", content: "DELTA-EVENT" }),
    priorCanonicalSummary: "Prior canonical state",
    priorCheckpoint,
    epoch: 4,
    infer: async (prompt) => {
      capturedPrompt = prompt;
      return "<summary>bounded result</summary>";
    },
  });

  assert.match(capturedPrompt, /delta compaction epoch 4/i);
  assert.match(capturedPrompt, /Prior canonical state/);
  assert.match(capturedPrompt, /Durable session checkpoint/);
  assert.match(capturedPrompt, /CODEWORD-ALPHA/);
  assert.match(capturedPrompt, /DELTA-EVENT/);
});

test("second compaction summarizes only the new epoch and preserves hard anchors", async () => {
  const oldPayloadMarker = "OLD-PAYLOAD-MUST-NOT-BE-RESENT";
  const originalTask = "Implement the migration. Golden fact: CODEWORD-DELTA must survive.";
  const firstConversation = [
    { role: "user", content: originalTask },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "old-read",
        function: { name: "read_file", arguments: JSON.stringify({ path: "src/old.ts" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "old-read",
      name: "read_file",
      content: JSON.stringify({
        path: "src/old.ts",
        sha256: "c".repeat(64),
        startLine: 1,
        endLine: 400,
        totalLines: 400,
        truncated: false,
        content: `${oldPayloadMarker}${"x".repeat(20_000)}`,
      }),
    },
  ];
  const first = await tryFullSummarization(firstConversation, {
    softCap: 2_000,
    infer: async () => "<summary>1. Primary Request and Intent\nPreserve CODEWORD-DELTA.\n7. Pending Tasks\nApply the delta.\n8. Current Work\nInitial inspection completed.\n9. Optional Next Step\nApply the delta.</summary>",
  });
  assert.equal(first?.performed, true);

  const firstCompacted = buildPostCompactMessages(first!.summary, firstConversation, {
    softCap: 2_000,
    ...(first?.checkpoint ? { checkpoint: first.checkpoint } : {}),
  });
  const secondInput = [
    ...firstCompacted,
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "new-read",
        function: { name: "read_file", arguments: JSON.stringify({ path: "src/new.ts" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "new-read",
      name: "read_file",
      content: JSON.stringify({
        path: "src/new.ts",
        sha256: "d".repeat(64),
        startLine: 1,
        endLine: 300,
        totalLines: 300,
        truncated: false,
        content: `NEW-DELTA-EVENT${"y".repeat(20_000)}`,
      }),
    },
  ];
  let secondPrompt = "";
  const second = await tryFullSummarization(secondInput, {
    softCap: 2_000,
    infer: async (prompt) => {
      secondPrompt = prompt;
      return "<summary>1. Primary Request and Intent\nPreserve CODEWORD-DELTA.\n7. Pending Tasks\nNone.\n8. Current Work\nDelta applied and verified.\n9. Optional Next Step\nNone.</summary>";
    },
  });

  assert.equal(second?.performed, true);
  assert.match(secondPrompt, /delta compaction epoch 2/i);
  assert.match(secondPrompt, /CODEWORD-DELTA/);
  assert.match(secondPrompt, /NEW-DELTA-EVENT/);
  assert.doesNotMatch(secondPrompt, new RegExp(oldPayloadMarker));
  const secondCompacted = buildPostCompactMessages(second!.summary, secondInput, {
    softCap: 2_000,
    ...(second?.checkpoint ? { checkpoint: second.checkpoint } : {}),
  });
  const checkpointMessage = secondCompacted.find(
    (message) => message.name === COMPACTION_CHECKPOINT_MESSAGE_NAME,
  );
  const checkpoint = checkpointMessage ? parseCompactionCheckpoint(checkpointMessage) : null;
  assert.equal(checkpoint?.epoch, 2);
  assert.equal(checkpoint?.originalTask, originalTask);
  assert.ok(checkpoint?.goldenFacts.some((fact) => fact.includes("CODEWORD-DELTA")));
  assert.deepEqual(checkpoint?.files.map((file) => file.path), ["src/old.ts", "src/new.ts"]);
});

test("tryFullSummarization rejects oversized and non-saving summaries", async () => {
  const conversation = [
    { role: "user", content: "Complete the bounded compaction test." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "large-output",
        function: { name: "bash", arguments: JSON.stringify({ cmd: "generate-output" }) },
      }],
    },
    { role: "tool", tool_call_id: "large-output", name: "bash", content: "x".repeat(20_000) },
  ];
  const oversized = await tryFullSummarization(conversation, {
    softCap: 2_000,
    maxSummaryChars: 1_000,
    infer: async () => `<summary>${"s".repeat(1_001)}</summary>`,
  });
  assert.equal(oversized?.performed, false);
  assert.match(oversized?.rejectionReason ?? "", /character cap/i);

  const nonSaving = await tryFullSummarization(conversation, {
    softCap: 2_000,
    maxSummaryChars: 30_000,
    minSavingsRatio: 0.10,
    infer: async () => `<summary>${"s".repeat(19_900)}</summary>`,
  });
  assert.equal(nonSaving?.performed, false);
  assert.match(nonSaving?.rejectionReason ?? "", /required/i);
});

test("buildPostCompactMessages produces boundary + checkpoint + summary + re-anchor + deferred-tools + last-user-task", () => {
  const messages = buildPostCompactMessages("summary text", [
    { role: "user", content: "old prompt" },
    { role: "assistant", tool_calls: [{ function: { name: "file_view", arguments: JSON.stringify({ path: "src/a.ts" }) } }] },
    { role: "tool", tool_call_id: "t1", name: "file_view", content: "abc" },
  ], { softCap: 1000 });
  assert.equal(messages.length, 6);
  assert.match(messages[0]?.content ?? "", /\[Reaper context boundary\]/);
  assert.doesNotMatch(messages[0]?.content ?? "", /\bscratchpad\b/i);
  assert.equal(messages[1]?.name, COMPACTION_CHECKPOINT_MESSAGE_NAME);
  assert.equal(parseCompactionCheckpoint(messages[1]!)?.originalTask, "old prompt");
  assert.match(messages[2]?.content ?? "", /summary text/);
  assert.match(messages[3]?.content ?? "", /Post-compact (?:progress|re-anchor)/);
  assert.doesNotMatch(messages[3]?.content ?? "", /\bscratchpad\b/i);
  assert.match(messages[4]?.content ?? "", /deferred tools/i);
  assert.equal(messages[5]?.content, "old prompt");
});


test("buildPostCompactMessages does not replace the task with runtime feedback", () => {
  const originalTask = "Repair the tenant-scoped webhook ledger.";
  const runtimeFeedback = [
    "[Runtime verification failed]\nFocused test failed.",
    "Your previous tool_calls were rejected by the runtime schema and were NOT executed.",
    "Your previous response promised a concrete action but emitted no structured tool_calls, so that action did not occur.",
    "Your previous turn returned no tool_calls and an empty assistant_message.",
  ];
  for (const feedback of runtimeFeedback) {
    const messages = buildPostCompactMessages("summary text", [
      { role: "user", content: originalTask },
      { role: "assistant", content: "Working." },
      { role: "user", content: feedback },
    ], { softCap: 1_000 });
    const checkpointMessage = messages.find(
      (message) => message.name === COMPACTION_CHECKPOINT_MESSAGE_NAME,
    );
    assert.equal(checkpointMessage && parseCompactionCheckpoint(checkpointMessage)?.currentTask, originalTask);
    assert.equal(messages.at(-1)?.content, originalTask);
  }
});
test("buildPostCompactMessages preserves system instructions", () => {
  const system = "System instruction that must survive compaction.";
  const messages = buildPostCompactMessages("summary text", [
    { role: "system", content: system },
    { role: "user", content: "current task" },
    { role: "tool", tool_call_id: "t1", name: "file_view", content: "old output" },
  ], { softCap: 1000 });

  assert.deepEqual(messages[0], { role: "system", content: system });
  assert.match(messages[1]?.content ?? "", /\[Reaper context boundary\]/);
  assert.equal(messages.at(-1)?.content, "current task");
});

test("buildPostCompactMessages preserves structured system content", () => {
  const structuredSystem = [
    { type: "text", text: "stable instruction" },
    { type: "image", image_url: "artifact://diagram" },
  ];
  const messages = buildPostCompactMessages("summary text", [
    { role: "system", content: structuredSystem },
    { role: "user", content: "current task" },
  ] as any, { softCap: 1000 });

  assert.deepEqual((messages[0] as any).content, structuredSystem);
  assert.equal(messages.at(-1)?.content, "current task");
});

test("extractPostCompactProgressHints resumes without scratchpad nudges", async () => {
  const { extractPostCompactProgressHints } = await import("../../src/context/full-summary.js");
  const hints = extractPostCompactProgressHints([
    {
      role: "assistant",
      tool_calls: [
        { function: { name: "scratchpad", arguments: JSON.stringify({ action: "append", note: "TOKEN" }) } },
        { function: { name: "bash", arguments: JSON.stringify({ cmd: "cat big/logdump.txt" }) } },
        { function: { name: "read_file", arguments: JSON.stringify({ path: "src/legacy.ts" }) } },
        { function: { name: "write_file", arguments: JSON.stringify({ path: "RESULT.json" }) } },
      ],
    },
  ]);
  assert.ok(hints.some((h) => /bash cat already ran/i.test(h)));
  assert.ok(hints.some((h) => /already wrote: RESULT\.json/i.test(h)));
  assert.ok(!hints.some((h) => /\bscratchpad\b/i.test(h)));
  assert.ok(hints.some((h) => /already viewed: src\/legacy\.ts/i.test(h)));
});