import test from "node:test";
import assert from "node:assert/strict";

import { pruneSupersededToolResults } from "../../src/context/supersede-prune.js";

function assistantWithRead(callId: string, filePath: string) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: filePath }),
        },
      },
    ],
  };
}

function toolResult(callId: string, content: string, extra?: Record<string, unknown>) {
  return { role: "tool", tool_call_id: callId, content, ...extra };
}

test("pruneSupersededToolResults keeps newest read and prunes older same-path reads", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "OLD CONTENT ".repeat(20)),
    assistantWithRead("c2", "src/a.ts"),
    toolResult("c2", "NEW CONTENT"),
  ];

  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.performed, true);
  assert.equal(result.pruned, 1);
  assert.ok(result.savedChars > 0);
  assert.equal(messages[2]!.content, "[superseded: file re-read later]");
  assert.equal(messages[4]!.content, "NEW CONTENT");
});

test("pruneSupersededToolResults does not mutate warm-prefix messages", () => {
  // Put a full read pair starting at index 0 and set warmPrefixCount=2
  // so the first tool result is protected even when superseded.
  const protectedMsgs: Array<Record<string, unknown>> = [
    assistantWithRead("c0", "src/a.ts"),
    toolResult("c0", "PROTECTED"),
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "NEWER"),
  ];
  const r = pruneSupersededToolResults(protectedMsgs, { warmPrefixCount: 2 });
  assert.equal(protectedMsgs[1]!.content, "PROTECTED");
  assert.equal(protectedMsgs[3]!.content, "NEWER");
  assert.equal(r.pruned, 0);
});

test("pruneSupersededToolResults prunes useless-flagged results", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "noise noise noise", { useless: true }),
  ];
  const r = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(r.pruned, 1);
  assert.equal(messages[2]!.content, "[useless tool result pruned]");
});

test("pruneSupersededToolResults is idempotent on already-pruned placeholders", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "[superseded: file re-read later]"),
    assistantWithRead("c2", "src/a.ts"),
    toolResult("c2", "NEW"),
  ];
  const r = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(r.pruned, 0);
  assert.equal(r.performed, false);
});
