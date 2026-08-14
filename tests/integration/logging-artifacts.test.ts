import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "../../src/artifacts/store.js";
import { TrajectoryLogger } from "../../src/logging/trajectory.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { logLangfuseEvent } from "../../src/logging/langfuse.js";

test("trajectory logger writes a session header and sequenced mutations", async () => {
  const workspaceRoot = await createTempWorkspace();
  const logger = new TrajectoryLogger(workspaceRoot);

  await logger.write({
    event_id: "event-1",
    run_id: "run-1",
    session_id: "session-1",
    trace_id: "trace-1",
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "session_start",
    level: "info",
    user_intent_summary: "test start",
  });

  const log = await readFile(logger.path, "utf8");
  const lines = log.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; type?: string; seq?: number });
  assert.equal(lines[0]?.kind, "header");
  assert.equal(lines[1]?.kind, "record");
  assert.equal(lines[1]?.type, "operation_started");
  assert.equal(lines[1]?.seq, 1);
  const index = await readFile(path.join(workspaceRoot, ".reaper", "logs", "session.index.json"), "utf8");
  assert.match(index, /event-1/);
});

test("second logger on same run resumes session.jsonl without a second header", async () => {
  const workspaceRoot = await createTempWorkspace();
  const first = new TrajectoryLogger(workspaceRoot, { runId: "run-resume" });
  await first.write({
    event_id: "event-start",
    run_id: "run-resume",
    session_id: "session-resume",
    trace_id: "trace-resume",
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "session_start",
    level: "info",
    user_intent_summary: "resume test",
  });
  await first.write({
    event_id: "event-assistant",
    run_id: "run-resume",
    session_id: "session-resume",
    trace_id: "trace-resume",
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "assistant_message",
    level: "info",
    content: "mid-run text",
    turn_index: 1,
  });

  const second = new TrajectoryLogger(workspaceRoot, { runId: "run-resume" });
  await second.write({
    event_id: "event-end",
    run_id: "run-resume",
    session_id: "session-resume",
    trace_id: "trace-resume",
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "run_end",
    level: "info",
    status: "completed",
    final_assistant_message: "done",
    duration_ms: 12,
  });

  const lines = (await readFile(first.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; type?: string; seq?: number });
  assert.equal(lines.filter((line) => line.kind === "header").length, 1);
  assert.equal(lines.at(-1)?.type, "operation_finished");
  assert.equal(lines.at(-1)?.seq, 3);
  const conversation = await readFile(path.join(workspaceRoot, ".reaper", "runs", "run-resume", "logs", "conversation.md"), "utf8");
  assert.match(conversation, /mid-run text/);
  assert.equal((conversation.match(/^# Conversation/gm) ?? []).length, 1);
});

test("artifact store saves and retrieves tool output", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = new ArtifactStore(workspaceRoot);

  const artifact = await store.put("tool_output", "hello artifact");
  const loaded = await store.get(artifact.artifactId);

  assert.equal(loaded.content, "hello artifact");
  assert.equal(loaded.sha256, artifact.sha256);
});

test("langfuse adapter stores all reaper observations in one local run log", async () => {
  const workspaceRoot = await createTempWorkspace();
  await logLangfuseEvent({
    workspaceRoot,
    name: "reaper.test.observation",
    type: "event",
    input: { prompt: "test" },
    output: { ok: true },
    trace: { runId: "run-1", sessionId: "session-1", traceId: "trace-1" },
  });

  const log = await readFile(path.join(workspaceRoot, ".reaper", "logs", "langfuse-events.jsonl"), "utf8");
  assert.match(log, /reaper\.test\.observation/);
  assert.match(log, /exportMode/);
  assert.match(log, /local_only/);
});

test.skip("large shell outputs are stored as artifacts and retrievable", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { cmd: "python -c \"import sys; sys.stdout.write('x' * 1100000)\"", timeout: 30 },
  });

  assert.equal(result.ok, true);
  const artifactId = (result.output as { artifactId?: string }).artifactId;
  assert.ok(artifactId);

  const fetched = await executor.execute({
    id: "2",
    name: "get_tool_output",
    args: { artifactId },
  });

  assert.equal(fetched.ok, true);
  assert.match(String((fetched.output as { content: string }).content.slice(0, 10)), /x+/);
});
