import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "../../src/artifacts/store.js";
import { TrajectoryLogger } from "../../src/logging/trajectory.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { logLangfuseEvent } from "../../src/logging/langfuse.js";

test("trajectory logger writes indexed entries with integrity hashes", async () => {
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
  const index = await readFile(path.join(workspaceRoot, ".reaper", "logs", "reaper-trajectory.index.json"), "utf8");
  assert.match(log, /entry_hash/);
  assert.match(log, /prev_hash/);
  assert.match(index, /event-1/);
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
    name: "run_shell_command",
    args: { cmd: "python -c \"import sys; sys.stdout.write('x' * 1100000)\"", timeoutMs: 30000 },
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
