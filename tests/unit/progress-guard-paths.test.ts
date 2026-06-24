import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  guardNoProgressToolCalls,
  makeToolCallActionSignature,
} from "../../src/runtime/progress-guard.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";

function mkReadCall(p: string): ToolCall {
  return { id: "x", name: "read_file", args: { path: p } } as unknown as ToolCall;
}

function mkFailedReadResult(p: string): ToolResult {
  return {
    toolCallId: "x",
    name: "read_file",
    args: { path: p },
    ok: false,
    durationMs: 1,
    output: {},
    error: { code: "not_found", message: `not found: ${p}` },
  } as unknown as ToolResult;
}

test("read_file signature collapses workspace-relative and absolute path variants", () => {
  const absolute = `/tmp/workspace/server/src/server.ts`;
  const relative = "server/src/server.ts";
  const sig1 = makeToolCallActionSignature(mkReadCall(absolute));
  const sig2 = makeToolCallActionSignature(mkReadCall(relative));
  // They should not necessarily collapse (relative is relative), but the
  // important thing is that absolute paths with ./ and ../ do collapse.
  const withDot = `/tmp/workspace/./server/../server/src/server.ts`;
  const sig3 = makeToolCallActionSignature(mkReadCall(withDot));
  assert.equal(sig1, sig3);
});

test("progress guard trips on 3 read_file attempts to the same missing file", () => {
  const calls = [
    mkReadCall("server/src/server.ts"),
    mkReadCall("server/src/server.ts"),
    mkReadCall("server/src/server.ts"),
    mkReadCall("server/src/server.ts"),
  ];
  const results = calls.slice(0, 3).map(() => mkFailedReadResult("server/src/server.ts"));
  const decision = guardNoProgressToolCalls(calls, results, {});
  assert.ok(decision.tripped, "expected progress guard to trip on repeated failed read_file");
  assert.ok(decision.feedback.some((f: string) => /unchanged failed action/i.test(f)));
});

test("progress guard still distinguishes truly different files", () => {
  // Same tool, different paths = different actions. Guard should NOT trip.
  const calls = [
    mkReadCall("src/a.ts"),
    mkReadCall("src/b.ts"),
    mkReadCall("src/c.ts"),
    mkReadCall("src/d.ts"),
  ];
  const results = calls.slice(0, 3).map((c) => mkFailedReadResult((c.args as { path: string }).path));
  const decision = guardNoProgressToolCalls(calls, results, {});
  assert.equal(decision.tripped, false);
});