import test from "node:test";
import assert from "node:assert/strict";

import {
  tryFullSummarization,
  buildPostCompactMessages,
  FULL_SUMMARY_DEFAULTS,
  runSummariser,
  extractSummary,
} from "../../src/context/full-summary.js";

test("extractSummary parses the canonical <summary> block", () => {
  const text = "<analysis>thinking</analysis><summary>1. intent\n2. work</summary>";
  assert.equal(extractSummary(text), "1. intent\n2. work");
});

test("extractSummary falls back to stripping analysis when no <summary> block", () => {
  const text = "<analysis>x</analysis>plain summary text here";
  assert.equal(extractSummary(text), "plain summary text here");
});

test("tryFullSummarization returns null when conversation is below threshold", async () => {
  const result = await tryFullSummarization(
    [{ role: "user", content: "small prompt" }],
    { softCap: 1_000_000, infer: async () => "ignored" },
  );
  assert.equal(result, null);
});

test("tryFullSummarization builds a 4-message compact conversation on success", async () => {
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
  // Re-anchor mentions the 3 most-recent files.
  const reattachContent = result?.summary ?? "";
  const messages = buildPostCompactMessages(fakeSummary, longConversation, { softCap: 25_000, maxFilesToRestore: 3 });
  assert.ok(messages.length >= 4, `expected >=4 messages, got ${messages.length}`);
  // The first message is the boundary marker.
  assert.ok(messages[0]?.content?.includes("[Reaper context boundary]"));
  // The second message is the summary.
  assert.ok(messages[1]?.content?.includes("1. intent"));
  // The third message is the re-anchor.
  assert.ok(messages[2]?.content?.includes("Post-compact re-anchor"));
  // The re-anchor lists 3 files (capped at maxFilesToRestore).
  const reattach = messages[2]?.content ?? "";
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
    { role: "user", content: `${marker} ${"x".repeat(200_000)}` },
    { role: "assistant", content: "continue" },
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

test("buildPostCompactMessages produces boundary + summary + re-anchor + deferred-tools + last-user-task", () => {
  const messages = buildPostCompactMessages("summary text", [
    { role: "user", content: "old prompt" },
    { role: "assistant", tool_calls: [{ function: { name: "file_view", arguments: JSON.stringify({ path: "src/a.ts" }) } }] },
    { role: "tool", tool_call_id: "t1", name: "file_view", content: "abc" },
  ], { softCap: 1000 });
  // Post-compact shape: [boundary, summary, re-anchor, deferred, last-user-task]
  assert.equal(messages.length, 5);
  assert.match(messages[0]?.content ?? "", /\[Reaper context boundary\]/);
  assert.doesNotMatch(messages[0]?.content ?? "", /\bscratchpad\b/i);
  assert.match(messages[1]?.content ?? "", /summary text/);
  assert.match(messages[2]?.content ?? "", /Post-compact (?:progress|re-anchor)/);
  assert.doesNotMatch(messages[2]?.content ?? "", /\bscratchpad\b/i);
  assert.match(messages[3]?.content ?? "", /deferred tools/i);
  // The last user-msg from the input is preserved (current task).
  assert.equal(messages[4]?.content, "old prompt");
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