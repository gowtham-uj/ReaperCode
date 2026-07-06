import test from "node:test";
import assert from "node:assert/strict";

import {
  maybeTimeBasedMicrocompact,
  TIME_MICROCOMPACT_PLACEHOLDER,
} from "../../src/context/time-microcompact.js";

const NOW = 1_700_000_000_000;
const ONE_MIN = 60_000;

test("time-microcompact is a no-op when disabled", () => {
  const messages = [{ role: "tool", content: "x".repeat(5_000), timestamp: NOW - 24 * 60 * ONE_MIN }];
  const result = maybeTimeBasedMicrocompact(messages, { enabled: false, nowMs: NOW });
  assert.equal(result.clearedResults, 0);
  assert.equal(messages[0]?.content, "x".repeat(5_000));
});

test("time-microcompact clears tool results older than the gap", () => {
  const messages: Array<Record<string, unknown>> = [];
  // 10 tool results, 8 of which are older than 60 minutes.
  for (let i = 0; i < 10; i += 1) {
    const ts = NOW - (i + 1) * 30 * ONE_MIN; // 30, 60, 90, ... minutes ago
    messages.push({ role: "tool", content: `m${i}-`.repeat(1_000), timestamp: ts });
  }
  const result = maybeTimeBasedMicrocompact(messages, { enabled: true, nowMs: NOW });
  assert.ok(result.clearedResults >= 3, `expected at least 3 cleared, got ${result.clearedResults}`);
  assert.ok(result.savedChars > 5_000);
  // The most recent tool results must NOT be cleared.
  const lastTool = messages[messages.length - 1] as { content: string };
  assert.equal(lastTool.content, `m9-`.repeat(1_000));
  // An older tool result that was cleared must have the placeholder.
  const clearedMessages = messages.filter((m) => m.content === TIME_MICROCOMPACT_PLACEHOLDER);
  assert.ok(clearedMessages.length >= 1);
});

test("time-microcompact skips tool results without a timestamp", () => {
  const messages = [{ role: "tool", content: "x".repeat(5_000) }];
  const result = maybeTimeBasedMicrocompact(messages, { enabled: true, nowMs: NOW });
  assert.equal(result.clearedResults, 0);
  assert.equal(messages[0]?.content, "x".repeat(5_000));
});

test("time-microcompact skips tool results below the min-content threshold", () => {
  const messages = [
    { role: "tool", content: "tiny", timestamp: NOW - 24 * 60 * ONE_MIN },
  ];
  const result = maybeTimeBasedMicrocompact(messages, { enabled: true, nowMs: NOW });
  assert.equal(result.clearedResults, 0);
  assert.equal(messages[0]?.content, "tiny");
});