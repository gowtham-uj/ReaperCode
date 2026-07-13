import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  setModelCallLogContext,
  logModelCall,
  renderModelCallTranscript,
  collectModelCallTranscripts,
} from "../../src/logging/model-call-log.js";

test("renderModelCallTranscript includes system, messages, and output", () => {
  const text = renderModelCallTranscript("0001-generate", {
    kind: "generate",
    role: "executor",
    durationMs: 12,
    profile: { provider: "minimax", model: "MiniMax-M3" },
    request: {
      role: "executor",
      system: "You are Reaper's main agent.",
      messages: [
        { role: "user", content: "Create hello.txt" },
        { role: "assistant", content: "Sure.", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"hello.txt\"}" } }] },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
      tools: [{ name: "write_file", description: "Write a file" }],
    } as any,
    response: {
      role: "executor",
      profileName: "executor",
      provider: "minimax",
      model: "MiniMax-M3",
      content: "Done.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
      raw: {},
    } as any,
  });
  assert.match(text, /You are Reaper's main agent/);
  assert.match(text, /Create hello\.txt/);
  assert.match(text, /write_file/);
  assert.match(text, /Done\./);
  assert.match(text, /MODEL OUTPUT/);
});

test("logModelCall writes json + txt + TRANSCRIPT.md", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-model-io-"));
  try {
    setModelCallLogContext({ workspaceRoot: root, runId: "run-test" });
    await logModelCall({
      kind: "generate",
      callId: "0001-generate",
      role: "executor",
      request: {
        role: "executor",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      } as any,
      response: {
        role: "executor",
        profileName: "executor",
        provider: "mock",
        model: "mock",
        content: "hello",
        raw: {},
      } as any,
      durationMs: 1,
    });
    const dir = path.join(root, ".reaper", "runs", "run-test", "model-calls");
    const json = readFileSync(path.join(dir, "0001-generate.json"), "utf8");
    const txt = readFileSync(path.join(dir, "0001-generate.txt"), "utf8");
    const transcript = readFileSync(path.join(dir, "TRANSCRIPT.md"), "utf8");
    assert.match(json, /"call_id": "0001-generate"/);
    assert.match(txt, /hi/);
    assert.match(txt, /hello/);
    assert.match(transcript, /0001-generate/);

    const dest = path.join(root, "MODEL_IO.md");
    const collected = await collectModelCallTranscripts(root, "run-test", dest);
    assert.equal(collected.calls, 1);
    assert.match(readFileSync(dest, "utf8"), /Model I\/O Transcript/);
  } finally {
    setModelCallLogContext(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
