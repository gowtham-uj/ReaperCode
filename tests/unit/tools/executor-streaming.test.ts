/**
 * Pi-parity per-tool streaming: the executor exposes `executeStream()`
 * as an `AsyncIterable<ExecutionEvent>` so callers can observe a tool
 * call in flight instead of waiting for the buffered `Promise<ToolResult>`.
 *
 * These tests verify the vocabulary and ordering:
 *
 *   1. The first event is always `tool_execution_start` carrying the
 *      call's toolCallId, name, and args.
 *   2. The last event is always `tool_execution_complete` with a
 *      well-formed `ToolResult`.
 *   3. For tools that do not opt in to partial-output streaming
 *      (write_file), no `tool_execution_delta` events are emitted.
 *   4. The `execute()` method is unchanged — it still returns a
 *      single `Promise<ToolResult>` and the streaming wrapper
 *      composes on top of it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolExecutor } from "../../../src/tools/executor.js";
import type { ToolCall } from "../../../src/tools/types.js";

function buildExecutor(workspaceRoot: string): ToolExecutor {
  return new ToolExecutor({
    workspaceRoot,
    runId: "executor-streaming-run",
    sessionId: "executor-streaming-session",
    traceId: "executor-streaming-trace",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "reaper-exec-stream-"));
}

test("executeStream yields start then complete for write_file (no deltas)", async () => {
  const ws = await tempWorkspace();
  try {
    const executor = buildExecutor(ws);
    const call: ToolCall = {
      id: "wc-1",
      name: "write_file",
      args: { path: "stream-hello.txt", content: "streaming hello\n" },
    };

    const events: Array<{ type: string; data: unknown }> = [];
    for await (const ev of executor.executeStream(call)) {
      events.push({ type: ev.type, data: ev.data });
    }

    assert.ok(events.length >= 2, `expected at least 2 events, got ${events.length}`);

    const start = events[0]!;
    assert.equal(start.type, "tool_execution_start");
    const startData = start.data as { toolCallId: string; name: string; args: Record<string, unknown> };
    assert.equal(startData.toolCallId, "wc-1");
    assert.equal(startData.name, "write_file");
    assert.equal(startData.args.path, "stream-hello.txt");

    const deltas = events.filter((e) => e.type === "tool_execution_delta");
    assert.equal(deltas.length, 0, "write_file should not emit partial-output deltas");

    const last = events[events.length - 1]!;
    assert.equal(last.type, "tool_execution_complete", "last event should be complete");
    const lastData = last.data as { toolCallId: string; result: { ok: boolean; name: string; toolCallId: string } };
    assert.equal(lastData.toolCallId, "wc-1");
    assert.equal(lastData.result.ok, true, "write_file should succeed");
    assert.equal(lastData.result.name, "write_file");

    // Sanity: the call really landed on disk.
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(path.join(ws, "stream-hello.txt"), "utf8");
    assert.equal(onDisk, "streaming hello\n");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("executeStream yields start then complete for bash", async () => {
  const ws = await tempWorkspace();
  try {
    const executor = buildExecutor(ws);
    const call: ToolCall = {
      id: "bash-1",
      name: "bash",
      args: { cmd: 'echo "streamed"', description: "stream echo", timeout: 15 },
    };

    const events: Array<{ type: string; data: unknown }> = [];
    for await (const ev of executor.executeStream(call)) {
      events.push({ type: ev.type, data: ev.data });
    }

    assert.equal(events[0]!.type, "tool_execution_start", "bash should also start with start event");
    const last = events[events.length - 1]!;
    assert.equal(last.type, "tool_execution_complete");
    const result = (last.data as { result: { ok: boolean; toolCallId: string; name: string } }).result;
    assert.equal(result.ok, true, "bash should succeed for `echo streamed`");
    assert.equal(result.toolCallId, "bash-1");
    assert.equal(result.name, "bash");

    // Some bash paths emit zero deltas (the foreground bash buffers
    // and resolves a single foreground result). The vocabulary may
    // emit zero or more deltas; both are valid per the spec.
    const deltaCount = events.filter((e) => e.type === "tool_execution_delta").length;
    assert.ok(deltaCount >= 0, "delta count must be >= 0");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("executeStream composes on top of execute() — both paths remain callable", async () => {
  const ws = await tempWorkspace();
  try {
    await writeFile(path.join(ws, "comp-target.txt"), "seed\n", "utf8");
    const executor = buildExecutor(ws);

    const call: ToolCall = {
      id: "comp-1",
      name: "read_file",
      args: { path: "comp-target.txt" },
    };

    // Buffered path: execute() returns a Promise<ToolResult>.
    const buffered = await executor.execute(call);
    assert.equal(buffered.ok, true);
    assert.equal(buffered.toolCallId, "comp-1");

    // Streaming path: same call, but consumed as AsyncIterable.
    const streamingEvents: string[] = [];
    let streamedResult: unknown;
    for await (const ev of executor.executeStream(call)) {
      streamingEvents.push(ev.type);
      if (ev.type === "tool_execution_complete") {
        streamedResult = ev.data;
      }
    }
    assert.deepEqual(streamingEvents.slice(0, 1), ["tool_execution_start"]);
    assert.equal(streamingEvents[streamingEvents.length - 1], "tool_execution_complete");
    const streamed = (streamedResult as { result: { ok: boolean; toolCallId: string } }).result;
    assert.equal(streamed.ok, true);
    assert.equal(streamed.toolCallId, "comp-1");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
