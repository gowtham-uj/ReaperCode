import test from "node:test";
import assert from "node:assert/strict";
import { shakeConversation, shouldShake, estimateTokens } from "../../src/context/shake.js";

interface ShakeTestMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

const OBSERVATION_HASH_A = "a".repeat(64);
const OBSERVATION_HASH_B = "b".repeat(64);

function fileViewObservation(
  filePath: string,
  sha256: string | undefined,
  startLine: number,
  endLine: number,
): string {
  return JSON.stringify({
    kind: "file_view",
    path: filePath,
    ...(sha256 ? { sha256, mtimeMs: 1_700_000_000_000 } : {}),
    startLine,
    endLine,
    totalLines: 100,
    truncated: true,
    window: ["evidence ".repeat(80)],
  });
}

test("shouldShake returns false for small conversations", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi", tool_calls: [] },
    { role: "tool", tool_call_id: "1", content: "result" },
  ];
  assert.equal(shouldShake(messages, 262_128), false);
});

test("shouldShake returns true when context exceeds 60% of window", () => {
  const bigContent = "x".repeat(700_000); // ~175K tokens, > 60% of 262K
  const messages = [{ role: "user", content: bigContent }];
  assert.equal(shouldShake(messages, 262_128), true);
});

test("shake replaces write_file acks with placeholders", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  for (let i = 0; i < 30; i++) {
    const callId = `call-${i}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `src/file${i}.ts`, content: "code" }) } }],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ path: `src/file${i}.ts`, written: true, bytes: 100 }) });
  }
  // Use a small context window to force the shake threshold.
  const result = shakeConversation(messages, 500, { shakeMinSavingsChars: 1 });
  assert.ok(result.performed, "shake should have been performed");
  assert.ok(result.shaken > 0, "at least some results should be shaken");
  assert.ok(result.savedChars > 0, "should have saved chars");
  const toolResults = messages.filter(m => m.role === "tool");
  const placeholders = toolResults.filter(m => m.content.startsWith("[") && m.content.endsWith("]"));
  assert.ok(placeholders.length > 0, "should have placeholder results");
});

test("shake protects recent tool results", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  for (let i = 0; i < 20; i++) {
    const callId = `old-call-${i}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `old${i}.ts`, content: "x" }) } }],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ path: `old${i}.ts`, written: true, bytes: 100 }) });
  }
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "recent-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "pnpm test", timeout: 60 }) } }] });
  const recentContent = JSON.stringify({ stdout: "all tests passed\n", stderr: "", exitCode: 0 });
  messages.push({ role: "tool", tool_call_id: "recent-call", content: recentContent });

  const result = shakeConversation(messages, 500, { shakeMinSavingsChars: 1 });
  assert.ok(result.performed, "shake should have been performed");
  const recentResult = messages.find(m => m.tool_call_id === "recent-call");
  assert.equal(recentResult?.content, recentContent, "recent bash result should be protected");
});

test("shake replaces stale bash install output after a newer batch exists", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  const callId = "install-call";
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "pnpm install", timeout: 300 }) } }],
  });
  messages.push({
    role: "tool",
    tool_call_id: callId,
    content: JSON.stringify({ stdout: "Packages: 100\nDone in 5.2s\n" + "x".repeat(300), stderr: "", exitCode: 0 }),
  });
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "current-call", type: "function", function: { name: "file_view", arguments: JSON.stringify({ path: "src/current.ts" }) } }],
  });
  const currentContent = JSON.stringify({ kind: "file_view", window: ["current evidence"] });
  messages.push({ role: "tool", tool_call_id: "current-call", content: currentContent });

  const result = shakeConversation(messages, 500, { shakeMinSavingsChars: 1 });
  assert.ok(result.performed, "shake should trigger");
  const installResult = messages.find(m => m.tool_call_id === callId);
  assert.ok(installResult?.content.startsWith("[bash:"), "stale install output should be replaced");
  assert.equal(messages.find(m => m.tool_call_id === "current-call")?.content, currentContent);
});

test("shake does not touch the cockpit message", () => {
  const cockpit = "cockpit " + "x".repeat(5000);
  const messages: ShakeTestMessage[] = [{ role: "user", content: cockpit }];
  for (let i = 0; i < 20; i++) {
    const callId = `call-${i}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `file${i}.ts`, content: "x" }) } }],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ path: `file${i}.ts`, written: true }) });
  }

  shakeConversation(messages, 500);
  assert.equal(messages[0].content, cockpit, "cockpit message should be untouched");
});

test("shake keeps error outputs intact", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  const callId = "error-call";
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "pnpm test", timeout: 60 }) } }],
  });
  const errorContent = JSON.stringify({ stdout: "Error: test failed\n  at line 42\n" + "x".repeat(300), stderr: "", exitCode: 1 });
  messages.push({ role: "tool", tool_call_id: callId, content: errorContent });

  shakeConversation(messages, 500);
  const errorResult = messages.find(m => m.tool_call_id === callId);
  assert.equal(errorResult?.content, errorContent, "error output should be kept intact");
});

test("shake protects every result in the newest parallel tool batch", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  for (let i = 0; i < 4; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `old-${i}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `old-${i}.ts` }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `old-${i}`, content: `File written ${"x".repeat(500)}` });
  }
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "latest-a", type: "function", function: { name: "file_view", arguments: JSON.stringify({ path: "a.ts" }) } },
      { id: "latest-b", type: "function", function: { name: "file_view", arguments: JSON.stringify({ path: "b.ts" }) } },
    ],
  });
  const latestA = JSON.stringify({ kind: "file_view", window: ["a".repeat(2000)] });
  const latestB = JSON.stringify({ kind: "file_view", window: ["b".repeat(2000)] });
  messages.push({ role: "tool", tool_call_id: "latest-a", content: latestA });
  messages.push({ role: "tool", tool_call_id: "latest-b", content: latestB });

  const result = shakeConversation(messages, 500, {
    shakeProtectWindowChars: 200,
    shakeMinSavingsChars: 1,
  });
  assert.equal(result.performed, true);
  assert.equal(messages.find(m => m.tool_call_id === "latest-a")?.content, latestA);
  assert.equal(messages.find(m => m.tool_call_id === "latest-b")?.content, latestB);
});

test("shake below its savings threshold leaves the conversation byte-for-byte intact", () => {
  const messages: ShakeTestMessage[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  for (let i = 0; i < 3; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call-${i}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `file-${i}.ts` }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `call-${i}`, content: `File written ${"x".repeat(500)}` });
  }
  const before = structuredClone(messages);
  const result = shakeConversation(messages, 500, { shakeMinSavingsChars: 1_000_000 });
  assert.equal(result.performed, false);
  assert.deepEqual(messages, before);
});

test("shake compacts an older read only when a later same-hash window covers it", () => {
  const oldContent = fileViewObservation("src/a.ts", OBSERVATION_HASH_A, 10, 21);
  const coveringContent = fileViewObservation("src/a.ts", OBSERVATION_HASH_A, 1, 51);
  const messages: ShakeTestMessage[] = [
    { role: "user", content: "cockpit " + "x".repeat(5000) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "old-read",
        function: { name: "file_view", arguments: JSON.stringify({ path: "src/a.ts" }) },
      }],
    },
    { role: "tool", tool_call_id: "old-read", content: oldContent },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "covering-read",
        function: { name: "file_view", arguments: JSON.stringify({ path: "src/a.ts" }) },
      }],
    },
    { role: "tool", tool_call_id: "covering-read", content: coveringContent },
  ];

  const result = shakeConversation(messages, 500, {
    shakeProtectWindowChars: 64_000,
    shakeMinSavingsChars: 1,
  });
  assert.equal(result.performed, true);
  assert.match(messages[2]?.content ?? "", /^\[file_view:/);
  assert.equal(messages[4]?.content, coveringContent);
});

test("shake retains changed, disjoint, and unproven file observations", () => {
  const changed = fileViewObservation("src/changed.ts", OBSERVATION_HASH_A, 1, 21);
  const disjoint = fileViewObservation("src/disjoint.ts", OBSERVATION_HASH_A, 1, 21);
  const unknown = fileViewObservation("src/unknown.ts", undefined, 1, 21);
  const messages: ShakeTestMessage[] = [
    { role: "user", content: "cockpit " + "x".repeat(5000) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "changed-old", function: { name: "file_view", arguments: "{\"path\":\"src/changed.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "changed-old", content: changed },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "changed-new", function: { name: "file_view", arguments: "{\"path\":\"src/changed.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "changed-new", content: fileViewObservation("src/changed.ts", OBSERVATION_HASH_B, 1, 51) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "disjoint-old", function: { name: "file_view", arguments: "{\"path\":\"src/disjoint.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "disjoint-old", content: disjoint },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "disjoint-new", function: { name: "file_view", arguments: "{\"path\":\"src/disjoint.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "disjoint-new", content: fileViewObservation("src/disjoint.ts", OBSERVATION_HASH_A, 21, 41) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "unknown-old", function: { name: "file_view", arguments: "{\"path\":\"src/unknown.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "unknown-old", content: unknown },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "unknown-new", function: { name: "file_view", arguments: "{\"path\":\"src/unknown.ts\"}" } }],
    },
    { role: "tool", tool_call_id: "unknown-new", content: fileViewObservation("src/unknown.ts", OBSERVATION_HASH_A, 1, 51) },
  ];

  const result = shakeConversation(messages, 500, {
    shakeProtectWindowChars: 200,
    shakeMinSavingsChars: 1,
  });
  assert.equal(result.performed, false);
  assert.equal(messages[2]?.content, changed);
  assert.equal(messages[6]?.content, disjoint);
  assert.equal(messages[10]?.content, unknown);
});

test("shake scales protection down at low caps while preserving the newest batch", () => {
  const oldContent = `File written ${"x".repeat(500)}`;
  const newestContent = JSON.stringify({ ok: true, value: "newest unobserved result" });
  const messages: ShakeTestMessage[] = [
    { role: "user", content: "cockpit " + "x".repeat(5000) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "old-write",
        function: { name: "write_file", arguments: JSON.stringify({ path: "src/old.ts" }) },
      }],
    },
    { role: "tool", tool_call_id: "old-write", content: oldContent },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "newest",
        function: { name: "bash", arguments: JSON.stringify({ cmd: "echo newest" }) },
      }],
    },
    { role: "tool", tool_call_id: "newest", content: newestContent },
  ];

  const result = shakeConversation(messages, 500, {
    shakeProtectWindowChars: 64_000,
    shakeMinSavingsChars: 1,
  });
  assert.equal(result.performed, true);
  assert.match(messages[2]?.content ?? "", /^\[write_file:/);
  assert.equal(messages[4]?.content, newestContent);
});

test("estimateTokens converts chars to approximate tokens", () => {
  assert.equal(estimateTokens(8000), 2000);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(400), 100);
});
