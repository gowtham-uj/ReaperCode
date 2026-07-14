import test from "node:test";
import assert from "node:assert/strict";

import { pruneSupersededToolResults } from "../../src/context/supersede-prune.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function assistantWithRead(
  callId: string,
  filePath: string,
  name = "read_file",
) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify({ path: filePath }),
        },
      },
    ],
  };
}

function toolResult(callId: string, content: string, extra?: Record<string, unknown>) {
  return { role: "tool", tool_call_id: callId, content, ...extra };
}

function textObservation(
  filePath: string,
  sha256: string,
  startLine: number,
  endLine: number,
  totalLines = 100,
): string {
  return JSON.stringify({
    kind: "text",
    path: filePath,
    sha256,
    mtimeMs: 1_700_000_000_000,
    startLine,
    endLine,
    totalLines,
    truncated: false,
    content: `${startLine}: observed`,
  });
}

test("pruneSupersededToolResults prunes a same-hash read covered by a later normalized-path read", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src\\a.ts"),
    toolResult("c1", textObservation("src\\a.ts", HASH_A, 10, 20)),
    assistantWithRead("c2", "src/a.ts"),
    toolResult("c2", textObservation("src/a.ts", HASH_A, 1, 50)),
  ];

  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.performed, true);
  assert.equal(result.pruned, 1);
  assert.ok(result.savedChars > 0);
  assert.equal(messages[2]?.content, "[superseded: file re-read later]");
  assert.equal(messages[4]?.content, textObservation("src/a.ts", HASH_A, 1, 50));
});

test("pruneSupersededToolResults retains changed, disjoint, and unproven reads", () => {
  const changed = textObservation("src/changed.ts", HASH_A, 1, 20);
  const disjoint = textObservation("src/disjoint.ts", HASH_A, 1, 20);
  const unknown = JSON.stringify({
    kind: "text",
    path: "src/unknown.ts",
    startLine: 1,
    endLine: 20,
    totalLines: 100,
    truncated: false,
    content: "unknown version",
  });
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("changed-old", "src/changed.ts"),
    toolResult("changed-old", changed),
    assistantWithRead("changed-new", "src/changed.ts"),
    toolResult("changed-new", textObservation("src/changed.ts", HASH_B, 1, 50)),
    assistantWithRead("disjoint-old", "src/disjoint.ts"),
    toolResult("disjoint-old", disjoint),
    assistantWithRead("disjoint-new", "src/disjoint.ts"),
    toolResult("disjoint-new", textObservation("src/disjoint.ts", HASH_A, 21, 40)),
    assistantWithRead("unknown-old", "src/unknown.ts"),
    toolResult("unknown-old", unknown),
    assistantWithRead("unknown-new", "src/unknown.ts"),
    toolResult("unknown-new", textObservation("src/unknown.ts", HASH_A, 1, 50)),
  ];

  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.performed, false);
  assert.equal(result.pruned, 0);
  assert.equal(messages[2]?.content, changed);
  assert.equal(messages[6]?.content, disjoint);
  assert.equal(messages[10]?.content, unknown);
});

test("pruneSupersededToolResults recognizes exact whole-file image equivalents", () => {
  const wholeImage = JSON.stringify({
    kind: "image",
    path: "assets/logo.png",
    sha256: HASH_A,
    mtimeMs: 1_700_000_000_000,
    mimeType: "image/png",
    bytes: 12,
    base64: "payload",
  });
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("image-old", "assets/logo.png"),
    toolResult("image-old", wholeImage),
    assistantWithRead("image-new", "assets/logo.png"),
    toolResult("image-new", wholeImage),
  ];

  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.pruned, 1);
  assert.equal(messages[2]?.content, "[superseded: file re-read later]");
  assert.equal(messages[4]?.content, wholeImage);
});

test("pruneSupersededToolResults does not mutate warm-prefix messages", () => {
  const protectedObservation = textObservation("src/a.ts", HASH_A, 1, 20);
  const protectedMessages: Array<Record<string, unknown>> = [
    assistantWithRead("c0", "src/a.ts"),
    toolResult("c0", protectedObservation),
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", textObservation("src/a.ts", HASH_A, 1, 50)),
  ];
  const result = pruneSupersededToolResults(protectedMessages, { warmPrefixCount: 2 });
  assert.equal(protectedMessages[1]?.content, protectedObservation);
  assert.equal(result.pruned, 0);
});

test("pruneSupersededToolResults prunes useless-flagged results", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "noise noise noise", { useless: true }),
  ];
  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.pruned, 1);
  assert.equal(messages[2]?.content, "[useless tool result pruned]");
});

test("pruneSupersededToolResults is idempotent on already-pruned placeholders", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "cockpit" },
    assistantWithRead("c1", "src/a.ts"),
    toolResult("c1", "[superseded: file re-read later]"),
    assistantWithRead("c2", "src/a.ts"),
    toolResult("c2", textObservation("src/a.ts", HASH_A, 1, 50)),
  ];
  const result = pruneSupersededToolResults(messages, { warmPrefixCount: 1 });
  assert.equal(result.pruned, 0);
  assert.equal(result.performed, false);
});
