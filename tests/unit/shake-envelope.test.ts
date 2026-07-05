import test from "node:test";
import assert from "node:assert/strict";

import { shakeConversation } from "../../src/context/shake.js";

function buildConversation(toolName: string, args: unknown, content: string, repeat = 1): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "do the thing" },
  ];
  for (let i = 0; i < repeat; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call-${i}`, function: { name: toolName, arguments: JSON.stringify(args) } }] });
    messages.push({ role: "tool", tool_call_id: `call-${i}`, content });
  }
  return messages;
}

test("shake uses normalized envelope pruneReplacement for write_file/file_edit acks", () => {
  // Pad the conversation past the shake threshold with enough write_file
  // acks that the protect window can't cover them all (otherwise the only
  // tool result gets protected and nothing is shaken).
  const padding = "x".repeat(20_000);
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: `do the thing ${padding}` },
  ];
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call-${i}`, function: { name: "write_file", arguments: JSON.stringify({ path: "src/big.ts" }) } }] });
    messages.push({ role: "tool", tool_call_id: `call-${i}`, content: "File written: src/big.ts" });
  }
  shakeConversation(messages as unknown as Parameters<typeof shakeConversation>[0], 200);
  const toolMessages = messages.filter((m) => m.role === "tool");
  const shaken = toolMessages.filter((m) => m.content === "[write_file: src/big.ts]");
  assert.ok(shaken.length >= 1, `expected at least 1 shaken, got ${shaken.length}`);
});

test("shake prefers normalized envelope for large bash output when safeToPrune is set", () => {
  // Pad to exceed the shake threshold; many bash results so at least one
  // falls outside the protect window.
  const padding = "x".repeat(20_000);
  const longContent = "ok\n".repeat(800); // 2400 chars
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: `do the thing ${padding}` },
  ];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call-${i}`, function: { name: "bash", arguments: JSON.stringify({ cmd: "pnpm test" }) } }] });
    messages.push({ role: "tool", tool_call_id: `call-${i}`, content: longContent });
  }
  shakeConversation(messages as unknown as Parameters<typeof shakeConversation>[0], 200);
  const toolMessages = messages.filter((m) => m.role === "tool");
  const shaken = toolMessages.filter((m) => typeof m.content === "string" && m.content.startsWith("[bash:"));
  assert.ok(shaken.length > 0, "expected at least one shaken bash message");
  assert.ok(shaken.every((m) => m.content === "[bash: completed, 2400 bytes]"));
});