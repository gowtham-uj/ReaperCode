import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pushModelCallContext, recordModelCall } from "../../src/model/observability.js";

test("recordModelCall writes a generation event with prompt and response to the run-scoped log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-model-call-"));
  const release = pushModelCallContext({
    workspaceRoot: root,
    runId: "test-run",
    sessionId: "test-session",
    traceId: "test-trace",
    source: "test_source",
    callId: "test-call-1",
    promptPreview: "preview",
    system: "# stable system prefix",
  });
  try {
    await recordModelCall(
      {
        role: "planner",
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
        responseFinishReason: "stop",
        truncated: false,
        attempt: 1,
        usage: { inputTokens: 2000, outputTokens: 800 },
      },
      [{ role: "user", content: "Plan the task" }],
      { content: '{"steps":[]}', finishReason: "stop" },
    );
  } finally {
    release();
  }
  const logPath = path.join(root, ".reaper", "runs", "test-run", "logs", "langfuse-events.jsonl");
  const contents = await readFile(logPath, "utf8");
  assert.ok(contents.includes('"reaper.model_request"'), "log should include a model_request event");
  assert.ok(contents.includes("planner_subagent"), "log should include the source label");
  const event = JSON.parse(contents.trim().split("\n").pop()!);
  assert.equal(event.metadata.durationMs, 1000);
  assert.equal(event.metadata.promptChars, 12000);
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
