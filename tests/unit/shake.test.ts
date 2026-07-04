import test from "node:test";
import assert from "node:assert/strict";
import { shakeConversation, shouldShake, estimateTokens } from "../../src/context/shake.js";

test("shouldShake returns false for small conversations", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi", tool_calls: [] },
    { role: "tool", tool_call_id: "1", content: "result" },
  ];
  assert.equal(shouldShake(messages, 262_128), false);
});

test("shouldShake returns true when context exceeds 50% of window", () => {
  const bigContent = "x".repeat(600_000); // ~150K tokens, > 50% of 262K
  const messages = [{ role: "user", content: bigContent }];
  assert.equal(shouldShake(messages, 262_128), true);
});

test("shake replaces write_file acks with placeholders", () => {
  const messages: any[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
  for (let i = 0; i < 30; i++) {
    const callId = `call-${i}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `src/file${i}.ts`, content: "code" }) } }],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ path: `src/file${i}.ts`, written: true, bytes: 100 }) });
  }
  // Use small context window to trigger shake (8000 chars = 2000 tokens, 50% of 1000 = 500)
  const result = shakeConversation(messages, 500);
  assert.ok(result.performed, "shake should have been performed");
  assert.ok(result.shaken > 0, "at least some results should be shaken");
  assert.ok(result.savedChars > 0, "should have saved chars");
  const toolResults = messages.filter(m => m.role === "tool");
  const placeholders = toolResults.filter(m => m.content.startsWith("[") && m.content.endsWith("]"));
  assert.ok(placeholders.length > 0, "should have placeholder results");
});

test("shake protects recent tool results", () => {
  const messages: any[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
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

  const result = shakeConversation(messages, 500);
  assert.ok(result.performed, "shake should have been performed");
  const recentResult = messages.find(m => m.tool_call_id === "recent-call");
  assert.equal(recentResult?.content, recentContent, "recent bash result should be protected");
});

test("shake replaces stale bash install outputs", () => {
  const messages: any[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
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

  const result = shakeConversation(messages, 500);
  assert.ok(result.performed, "shake should trigger");
  assert.ok(result.shaken > 0, "install output should be shaken");
  const installResult = messages.find(m => m.tool_call_id === callId);
  assert.ok(installResult?.content.startsWith("[bash:"), "should be replaced with placeholder");
});

test("shake does not touch the cockpit message", () => {
  const cockpit = "cockpit " + "x".repeat(5000);
  const messages: any[] = [{ role: "user", content: cockpit }];
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
  const messages: any[] = [{ role: "user", content: "cockpit " + "x".repeat(5000) }];
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

test("estimateTokens converts chars to approximate tokens", () => {
  assert.equal(estimateTokens(8000), 2000);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(400), 100);
});
