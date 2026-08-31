import test from "node:test";
import assert from "node:assert/strict";

import { SessionProjection, projectHistory, projectThread } from "../../src/app-server/session-projection.js";
import type { ThreadEventRecord } from "../../src/app-server/event-bus.js";
import type { ThreadMetadata } from "../../src/app-server/thread-store.js";

const NOW = "2026-08-27T00:00:00.000Z";

function withTs<T extends { type: string }>(event: T): T & { timestamp: string } {
  return { ...event, timestamp: NOW };
}

function record(partial: {
  threadId: string;
  event: ThreadEventRecord["event"];
  turnId?: string;
  sequence?: number;
}): ThreadEventRecord {
  return {
    sequence: partial.sequence ?? 1,
    timestamp: NOW,
    threadId: partial.threadId,
    ...(partial.turnId ? { turnId: partial.turnId } : {}),
    event: partial.event,
  };
}

const metadata: ThreadMetadata = {
  version: 1,
  threadId: "fix-auth",
  sessionName: "app-fix-auth",
  workspaceRoot: "/tmp/workspace",
  permissionMode: "yolo",
  status: "idle",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:01.000Z",
  title: "Fix auth",
};

test("session projection emits Codex thread, turn, and item notifications", () => {
  const projection = new SessionProjection();
  const methods: string[] = [];
  const emit = (event: ThreadEventRecord["event"], extra: { turnId?: string } = { turnId: "turn-1" }) => {
    const notes = projection.project(record({
      threadId: "fix-auth",
      event,
      ...(extra.turnId ? { turnId: extra.turnId } : {}),
    }), metadata);
    methods.push(...notes.map((note) => note.method));
    return notes;
  };

  const started = emit(withTs({ type: "thread.started", threadId: "fix-auth" }), {});
  assert.equal(started[0]?.method, "thread/started");
  const thread = started[0]?.params.thread as { id: string; sessionId: string };
  assert.equal(thread.id, "fix-auth");
  assert.equal(thread.sessionId, "app-fix-auth");

  emit(withTs({ type: "turn.user.message", threadId: "fix-auth", turnId: "turn-1", text: "Fix the race" }));
  const turnStarted = emit(withTs({ type: "turn.started", runId: "turn-1", sessionId: "fix-auth" }));
  assert.equal(turnStarted[0]?.method, "turn/started");
  assert.deepEqual(turnStarted[0]?.params.turn, { id: "turn-1", status: "inProgress", items: [] });
  assert.equal(turnStarted[1]?.method, "item/started");
  assert.equal((turnStarted[1]?.params.item as { type: string }).type, "userMessage");

  const deltas = emit(withTs({ type: "assistant.message.delta", text: "hello" }));
  assert.equal(deltas[0]?.method, "item/started");
  assert.equal((deltas[0]?.params.item as { type: string }).type, "agentMessage");
  assert.equal(deltas[1]?.method, "item/agentMessage/delta");
  assert.equal(deltas[1]?.params.delta, "hello");

  emit(withTs({ type: "assistant.reasoning.delta", text: "checking" }));
  emit(withTs({ type: "tool.started", toolCall: { id: "bash-1", name: "bash", args: { cmd: "printf hi" } } }));
  emit(withTs({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: "hi" }));
  emit(withTs({
    type: "tool.completed",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "printf hi" } },
    result: { name: "bash", toolCallId: "bash-1", ok: true, durationMs: 1, output: { stdout: "hi", exitCode: 0 } },
  }));
  emit(withTs({ type: "assistant.message.completed", text: "hello" }));
  const completed = emit(withTs({
    type: "turn.completed",
    runId: "turn-1",
    sessionId: "fix-auth",
    assistantMessage: "hello",
  }));

  assert.equal(completed[0]?.method, "turn/completed");
  const completedTurn = completed[0]?.params.turn as { status: string; items: Array<{ type: string }> };
  assert.equal(completedTurn.status, "completed");
  const types = completedTurn.items.map((item) => item.type);
  assert.deepEqual(types, ["userMessage", "agentMessage", "reasoning", "commandExecution"]);
  assert.ok(methods.includes("item/commandExecution/outputDelta"));
  assert.ok(methods.includes("item/reasoning/textDelta"));
  assert.ok(methods.includes("item/completed"));

  const overwrite = new SessionProjection();
  overwrite.project(record({
    threadId: "fix-auth",
    turnId: "turn-2",
    event: withTs({ type: "assistant.message.delta", text: "working" }),
  }), metadata);
  const completedItem = overwrite.project(record({
    threadId: "fix-auth",
    turnId: "turn-2",
    event: withTs({ type: "assistant.message.completed", text: "working later" }),
  }), metadata);
  assert.equal((completedItem[0]?.params.item as { text: string }).text, "working later");
  const duplicate = overwrite.project(record({
    threadId: "fix-auth",
    turnId: "turn-2",
    event: withTs({
      type: "turn.completed",
      runId: "turn-2",
      sessionId: "fix-auth",
      assistantMessage: "working later",
    }),
  }), metadata);
  assert.equal(duplicate[0]?.method, "turn/completed");
  const suppressed = overwrite.project(record({
    threadId: "fix-auth",
    turnId: "turn-2",
    event: withTs({
      type: "turn.completed",
      runId: "turn-2",
      sessionId: "fix-auth",
      assistantMessage: "working later",
    }),
  }), metadata);
  assert.deepEqual(suppressed, []);

  const aborted = new SessionProjection();
  const interrupted = aborted.project(record({
    threadId: "fix-auth",
    turnId: "turn-3",
    event: withTs({
      type: "turn.aborted",
      runId: "turn-3",
      sessionId: "fix-auth",
      reason: "interrupted",
    }),
  }), metadata);
  assert.equal(interrupted[0]?.method, "turn/completed");
  assert.equal((interrupted[0]?.params.turn as { status: string }).status, "interrupted");
});

test("aggregated command output is capped so a long build cannot grow it unboundedly", () => {
  const projection = new SessionProjection();
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId: "turn-1", event }), metadata);

  emit(withTs({ type: "tool.started", toolCall: { id: "bash-1", name: "bash", args: { cmd: "build" } } }));

  // 1MB of output, well past the 256KB cap.
  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 16; i++) {
    emit(withTs({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: chunk }));
  }
  // A final distinctive chunk so we can assert the *tail* is what survives.
  emit(withTs({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: "FINAL-LINE" }));

  const completed = emit(withTs({
    type: "turn.completed",
    runId: "turn-1",
    sessionId: "fix-auth",
    assistantMessage: "done",
  }));
  const items = (completed[0]?.params.turn as { items: Array<{ type: string; aggregatedOutput?: string }> }).items;
  const command = items.find((item) => item.type === "commandExecution");
  const output = command?.aggregatedOutput ?? "";

  assert.ok(output.length <= 256 * 1024, `expected output to be capped, got ${output.length} chars`);
  assert.ok(output.endsWith("FINAL-LINE"), "the most recent output must be the part that is kept");
  assert.match(output, /^\[\.\.\. earlier output truncated \.\.\.\]/);
});

test("token usage accumulates a real total instead of repeating the per-call numbers", () => {
  const projection = new SessionProjection();
  const emit = (inputTokens: number, outputTokens: number) =>
    projection.project(record({
      threadId: "fix-auth",
      turnId: "turn-1",
      event: withTs({ type: "token.usage", inputTokens, outputTokens }),
    }), metadata);

  const first = emit(100, 20);
  const firstUsage = first[0]?.params.tokenUsage as {
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
    last: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
  assert.deepEqual(firstUsage.total, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert.deepEqual(firstUsage.last, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });

  const second = emit(50, 10);
  const secondUsage = second[0]?.params.tokenUsage as {
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
    last: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
  // The regression: total used to be the same per-call numbers as last.
  assert.deepEqual(secondUsage.total, { inputTokens: 150, outputTokens: 30, totalTokens: 180 });
  assert.deepEqual(secondUsage.last, { inputTokens: 50, outputTokens: 10, totalTokens: 60 });
});

test("history projection turns named-session messages into Codex turns", () => {
  const turns = projectHistory([
    { role: "user", content: "first" },
    { role: "assistant", content: "ack" },
    { role: "user", content: "second" },
    { role: "assistant", content: "done" },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.items[0]?.type, "userMessage");
  assert.equal(turns[0]?.items[1]?.type, "agentMessage");
  assert.equal(projectThread(metadata, turns).preview, "Fix auth");
});

test("hydrate prepends journal history without duplicating a live matching turn", () => {
  const history = projectHistory([
    { role: "user", content: "first" },
    { role: "assistant", content: "ack" },
    { role: "user", content: "second" },
    { role: "assistant", content: "done" },
  ]);
  const projection = new SessionProjection();
  projection.project(record({
    threadId: "fix-auth",
    turnId: "live-turn",
    event: withTs({ type: "turn.user.message", threadId: "fix-auth", turnId: "live-turn", text: "second" }),
  }), metadata);
  projection.project(record({
    threadId: "fix-auth",
    turnId: "live-turn",
    event: withTs({ type: "turn.started", runId: "live-turn", sessionId: "fix-auth" }),
  }), metadata);
  projection.hydrate(history);
  const turns = projection.snapshotTurns();
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.id, "history-turn-1");
  assert.equal(turns[1]?.id, "live-turn");
  projection.hydrate(history);
  assert.equal(projection.snapshotTurns().length, 2);
});
