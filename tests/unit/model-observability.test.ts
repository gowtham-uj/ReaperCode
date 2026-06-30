import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { pushModelCallContext, recordModelCall } from "../../src/model/observability.js";

const execFile = promisify(execFileCallback);

test("recordModelCall writes a generation event with prompt and response to the run-scoped log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-model-call-"));
  const release = pushModelCallContext({
    workspaceRoot: root,
    runId: "test-run",
    sessionId: "test-session",
    traceId: "test-trace",
    source: "runtime_scope",
    callId: "test-call-1",
    promptPreview: "preview",
    system: "# stable system prefix",
  });
  try {
    await recordModelCall(
      {
        role: "main_reasoner",
        source: "planner_subagent",
        provider: "minimax",
        model: "MiniMax-M3",
        maxTokens: 8192,
        responseFormat: "json",
        startedAt: "2026-06-22T00:00:00.000Z",
        endedAt: "2026-06-22T00:00:01.000Z",
        durationMs: 1000,
        promptChars: 12000,
        responseChars: 4000,
        responseContentChars: 4000,
        responseFinishReason: undefined,
        truncated: false,
        attempt: 1,
        usage: { inputTokens: 2000, outputTokens: 800 },
      },
      [{ role: "user", content: "Plan the task" }],
      { content: '{"steps":[]}', finishReason: "tool_calls", toolCalls: [{ name: "read" }, { name: "edit" }] },
    );
  } finally {
    release();
  }
  const logPath = path.join(root, ".reaper", "runs", "test-run", "logs", "langfuse-events.jsonl");
  const contents = await readFile(logPath, "utf8");
  assert.ok(contents.includes('"reaper.model_request"'), "log should include a model_request event");
  assert.ok(contents.includes("planner_subagent"), "log should include the source label");
  const event = JSON.parse(contents.trim().split("\n").pop()!);
  assert.equal(event.metadata.source, "planner_subagent");
  assert.equal(event.metadata.profile, "strong_model");
  assert.equal(event.metadata.legacyRole, "main_reasoner");
  assert.equal(event.metadata.role, "main_reasoner");
  assert.equal(event.metadata.durationMs, 1000);
  assert.equal(event.metadata.promptChars, 12000);
  assert.equal(event.metadata.systemChars, "# stable system prefix".length);
  assert.equal(event.metadata.finishReason, "tool_calls");
  assert.equal(event.metadata.responseFinishReason, "tool_calls");
  assert.equal(event.metadata.toolCallCount, 2);
  assert.equal(event.metadata.callSiteSource, "runtime_scope");
  assert.equal(event.metadata.attempt, 1);
  assert.equal(event.metadata.usage.inputTokens, 2000);
  assert.match(event.input.prompt, /Plan the task/);
  assert.match(event.output.content, /"steps":\[\]/);
  await rm(root, { recursive: true, force: true });
});

test("recordModelCall is a no-op when no active context is set", async () => {
  await recordModelCall(
    {
      role: "executor",
      provider: "minimax",
      model: "MiniMax-M3",
      maxTokens: 8192,
      responseFormat: "text",
      startedAt: "2026-06-22T00:00:00.000Z",
      endedAt: "2026-06-22T00:00:01.000Z",
      durationMs: 1000,
      promptChars: 100,
      responseChars: 100,
      responseContentChars: 100,
      responseFinishReason: "stop",
      truncated: false,
      attempt: 1,
      usage: null,
    },
    [{ role: "user", content: "noop" }],
    { content: "noop" },
  );
  // If we got here without throwing, the no-op path is correct.
  assert.ok(true);
});

test("live_stats groups old and new model_request metadata without crashing", async () => {
  const liveStatsPath = path.resolve("scripts/live_stats.py");
  const python = `
import contextlib
import importlib.util
import io

spec = importlib.util.spec_from_file_location("live_stats", ${JSON.stringify(liveStatsPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

events = [
    {"metadata": {"role": "main_reasoner", "provider": "p", "model": "m", "promptChars": 10, "durationMs": 20}},
    {"metadata": {"source": "executor", "profile": "fast_model", "legacyRole": "fast_reasoner", "provider": "p", "model": "m2", "promptChars": 5}},
]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    mod.print_model_request_breakdown(events)
out = buf.getvalue()
assert "source=unknown_source calls=1" in out
assert "profile=strong_model legacyRole=main_reasoner" in out
assert "source=executor calls=1" in out
assert "profile=fast_model legacyRole=fast_reasoner" in out
`;
  await execFile("python3", ["-c", python]);
});
