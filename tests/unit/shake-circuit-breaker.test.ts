import test from "node:test";
import assert from "node:assert/strict";

import {
  shakeConversationWithBreaker,
  truncateHeadForPTLRecovery,
  MAX_CONSECUTIVE_FAILURES,
} from "../../src/context/shake.js";

type ShakeMessages = Parameters<typeof shakeConversationWithBreaker>[0];

test("circuit breaker aborts after MAX_CONSECUTIVE_FAILURES failed shake passes", () => {
  // Build a conversation that exceeds the shake threshold but has no
  // eligible replacements — i.e. shake always returns performed:false.
  // The protect window will absorb everything so no shake happens, but
  // shouldShake() reports the threshold exceeded → consecutiveFailures++.
  const messages: ShakeMessages = [
    { role: "user", content: "x".repeat(20_000) },
  ];
  // Two huge bash results inside the protect window.
  for (let i = 0; i < 2; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `b-${i}`, function: { name: "bash", arguments: JSON.stringify({ cmd: "echo hi" }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `b-${i}`, content: "y".repeat(15_000) });
  }
  let consecutive = 0;
  let last;
  // One pass will succeed (first time, user msg shakes), then subsequent
  // passes fail until the breaker trips at MAX_CONSECUTIVE_FAILURES.
  for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
    const { result, nextFailures } = shakeConversationWithBreaker(messages, 200, consecutive);
    consecutive = nextFailures;
    last = result;
    if (result.aborted) break;
  }
  assert.equal(consecutive, MAX_CONSECUTIVE_FAILURES);
  assert.equal(last?.aborted, true);
});

test("circuit breaker resets when shake performs a successful pass", () => {
  const messages: ShakeMessages = [
    { role: "user", content: "x".repeat(20_000) },
  ];
  // A huge unproven file_view result must remain intact.
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "v-0", function: { name: "file_view", arguments: JSON.stringify({ path: "a" }) } }],
  });
  messages.push({ role: "tool", tool_call_id: "v-0", content: "z".repeat(15_000) });
  // Add equivalent observations. Each older result is covered by a later
  // same-hash whole-file result; the newest remains protected.
  const sha256 = "a".repeat(64);
  for (let i = 0; i < 6; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `v-old-${i}`, function: { name: "file_view", arguments: JSON.stringify({ path: "old" }) } }],
    });
    messages.push({
      role: "tool",
      tool_call_id: `v-old-${i}`,
      content: JSON.stringify({
        kind: "file_view",
        path: "old",
        sha256,
        mtimeMs: 1_700_000_000_000,
        startLine: 1,
        endLine: 101,
        totalLines: 100,
        truncated: false,
        window: ["a".repeat(2_000)],
      }),
    });
  }
  const { result, nextFailures } = shakeConversationWithBreaker(messages, 200, 2, { shakeMinSavingsChars: 1 });
  assert.equal(result.performed, true);
  assert.equal(nextFailures, 0);
});

test("truncateHeadForPTLRecovery drops oldest large tool results up to maxDrops", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "u" },
    { role: "tool", tool_call_id: "t1", content: "a".repeat(5_000) },
    { role: "tool", tool_call_id: "t2", content: "b".repeat(5_000) },
    { role: "tool", tool_call_id: "t3", content: "c".repeat(5_000) },
    { role: "tool", tool_call_id: "t4", content: "d".repeat(5_000) },
    { role: "assistant", content: "x" },
    { role: "tool", tool_call_id: "t5", content: "e".repeat(5_000) },
  ];
  const result = truncateHeadForPTLRecovery(messages, { maxDrops: 3 });
  assert.equal(result.droppedResults, 3);
  assert.ok(result.savedChars > 14_000);
  // The first three tool messages were dropped (t1, t2, t3).
  assert.equal(messages[1]?.content, "[tool_result: dropped for PTL recovery]");
  assert.equal(messages[2]?.content, "[tool_result: dropped for PTL recovery]");
  assert.equal(messages[3]?.content, "[tool_result: dropped for PTL recovery]");
  // t4 and t5 must be preserved.
  const fourthToolContent = messages[4]?.content;
  const fifthToolContent = messages[6]?.content;
  assert.ok(typeof fourthToolContent === "string" && fourthToolContent.startsWith("d"));
  assert.ok(typeof fifthToolContent === "string" && fifthToolContent.startsWith("e"));
  // The user and assistant messages must NOT be touched.
  assert.equal(messages[0]?.content, "u");
  assert.equal(messages[5]?.content, "x");
});