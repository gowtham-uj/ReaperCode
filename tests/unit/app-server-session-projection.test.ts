import test from "node:test";
import assert from "node:assert/strict";

import { isReplayStable, SessionProjection, projectHistory, projectThread } from "../../src/app-server/session-projection.js";
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
  // The engine completes the assistant message for a model step *before* it
  // runs that step's tool calls (engine.ts:1410 vs the scheduler at 1713), so
  // this is the real order. Completing it after the tool would be a second
  // step, and would correctly project a second agentMessage.
  emit(withTs({ type: "assistant.message.completed", text: "hello" }));
  emit(withTs({ type: "tool.started", toolCall: { id: "bash-1", name: "bash", args: { cmd: "printf hi" } } }));
  emit(withTs({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: "hi" }));
  emit(withTs({
    type: "tool.completed",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "printf hi" } },
    result: { name: "bash", toolCallId: "bash-1", ok: true, durationMs: 1, output: { stdout: "hi", exitCode: 0 } },
  }));
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

test("a second model step appends its message after the tool calls, instead of overwriting the first", () => {
  const projection = new SessionProjection();
  const turnId = "turn-multi";
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId, event }), metadata);

  emit(withTs({ type: "turn.started", runId: turnId, sessionId: "fix-auth" }));
  emit(withTs({ type: "assistant.message.completed", text: "Reading the auth module" }));
  emit(withTs({ type: "tool.started", toolCall: { id: "view-1", name: "file_view", args: { path: "auth.ts", start_line: 1, window: 40 } } }));
  emit(withTs({
    type: "tool.completed",
    toolCall: { id: "view-1", name: "file_view", args: { path: "auth.ts", start_line: 1, window: 40 } },
    result: { name: "file_view", toolCallId: "view-1", ok: true, durationMs: 1, output: "contents" },
  }));
  // Second model request: this is a new step, not a correction of the first.
  emit(withTs({ type: "assistant.message.completed", text: "Auth uses a refresh token" }));
  const completed = emit(withTs({
    type: "turn.completed",
    runId: turnId,
    sessionId: "fix-auth",
    assistantMessage: "Auth uses a refresh token",
  }));

  const items = (completed[0]?.params.turn as { items: Array<{ type: string; text?: string }> }).items;
  assert.deepEqual(
    items.map((item) => item.type),
    ["agentMessage", "dynamicToolCall", "agentMessage"],
    "the second step's message must append after the tool call, not replace the first",
  );
  assert.equal(items[0]?.text, "Reading the auth module", "the first step's message must survive");
  assert.equal(items[2]?.text, "Auth uses a refresh token");
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

test("token usage forwards the model window and Reaper soft cap", () => {
  const projection = new SessionProjection();
  const notes = projection.project(record({
    threadId: "fix-auth",
    turnId: "turn-1",
    event: withTs({ type: "token.usage", inputTokens: 10, outputTokens: 5, modelContextWindow: 200_000, contextSoftCap: 270_000 }),
  }), metadata);
  const usage = notes[0]?.params.tokenUsage as {
    modelContextWindow: number | null;
    contextSoftCap?: number;
  };
  assert.equal(usage.modelContextWindow, 200_000);
  assert.equal(usage.contextSoftCap, 270_000);
});

test("token usage without window metadata leaves modelContextWindow null", () => {
  const projection = new SessionProjection();
  const notes = projection.project(record({
    threadId: "fix-auth",
    turnId: "turn-1",
    event: withTs({ type: "token.usage", inputTokens: 10, outputTokens: 5 }),
  }), metadata);
  const usage = notes[0]?.params.tokenUsage as { modelContextWindow: number | null; contextSoftCap?: number };
  assert.equal(usage.modelContextWindow, null);
  assert.equal(usage.contextSoftCap, undefined);
});

test("verification.completed forwards the verdict and retains it for late joiners", () => {
  const projection = new SessionProjection();
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId: "turn-1", event }), metadata);

  emit(withTs({ type: "verification.started", command: "node --test" }));
  const completed = emit(withTs({
    type: "verification.completed",
    ok: true,
    command: "node --test",
    verified: true,
    groundedSignal: { kind: "test", command: "node --test", grounded: true },
    failureClasses: [],
    attemptCount: 2,
  }));

  assert.equal(completed[0]?.method, "item/verification/updated");
  const verification = (completed[0]?.params.verification as { verified: boolean; attemptCount: number });
  assert.equal(verification.verified, true);
  assert.equal(verification.attemptCount, 2);

  // The started event carries no verdict and must not be retained.
  const snapshot = projection.snapshotVerification();
  assert.deepEqual(snapshot, {
    ...(completed[0]?.params.verification as Record<string, unknown>),
    timestamp: NOW,
  });
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

test("projectThread never surfaces a failed turn's error text as the thread preview", () => {
  const failed = projectThread({
    ...metadata,
    title: undefined,
    status: "error",
    lastTurn: {
      turnId: "turn-1",
      status: "failed",
      startedAt: NOW,
      completedAt: NOW,
      assistantMessage: "Error: provider transport failed after 3 retries",
      error: { name: "Error", message: "provider transport failed" },
    },
  } as ThreadMetadata);
  assert.equal(failed.preview, "");
  assert.equal(failed.name, undefined);
});

test("projectThread prefers an explicit title over the last assistant message", () => {
  const titled = projectThread({
    ...metadata,
    lastTurn: {
      turnId: "turn-1",
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
      assistantMessage: "some long assistant reply",
    },
  } as ThreadMetadata);
  assert.equal(titled.preview, "Fix auth");
  assert.equal(titled.name, "Fix auth");
});

/**
 * A replayed `thread.started` is how a reconnecting client relearns what a
 * thread is set to, so it must project the thread's *current* metadata rather
 * than whatever it looked like when the event was first recorded.
 *
 * This is also why the message processor must not memoize this one
 * projection: `isReplayStable` is the predicate that keeps the cache honest,
 * and if it ever returned true here, a thread configured mid-conversation
 * would come back to a reloading client with its settings stripped.
 */
test("thread.started projects current metadata, not the creation-time snapshot", () => {
  const projection = new SessionProjection();
  const started = record({ threadId: "fix-auth", event: withTs({ type: "thread.started", threadId: "fix-auth" }) });

  const before = projection.project(started, metadata);
  assert.equal((before[0]?.params.thread as { systemPrompt?: string }).systemPrompt, undefined);

  const configured: ThreadMetadata = {
    ...metadata,
    systemPrompt: "Always write commit messages in the imperative mood.",
    disabledTools: ["bash"],
    updatedAt: "2026-08-27T01:00:00.000Z",
  };
  const after = projection.project(started, configured);
  const thread = after[0]?.params.thread as { systemPrompt?: string; disabledTools?: string[] };
  assert.equal(thread.systemPrompt, "Always write commit messages in the imperative mood.");
  assert.deepEqual(thread.disabledTools, ["bash"]);
});

test("isReplayStable rejects cached projections that embed live metadata", () => {
  const projection = new SessionProjection();
  const started = projection.project(
    record({ threadId: "fix-auth", event: withTs({ type: "thread.started", threadId: "fix-auth" }) }),
    metadata,
  );
  assert.equal(isReplayStable(started), false, "thread/started must never be memoized");

  const delta = projection.project(
    record({ threadId: "fix-auth", event: withTs({ type: "assistant.message.delta", text: "hi" }) }),
    metadata,
  );
  assert.equal(isReplayStable(delta), true, "record-only projections are safe to memoize");
});

/**
 * Code Mode streams on the same `command.output.delta` channel a shell command
 * uses — from the model's side it is the same thing: output produced *by* the
 * call, as it happens. It must not, however, be *projected* as a command
 * execution. The item is a tool call, and inventing a `commandExecution` for it
 * would produce a duplicate row that is thrown away the moment the real report
 * lands, since completing the call replaces that item wholesale.
 */
test("Code Mode output streams on its own notification instead of inventing a command item", () => {
  const projection = new SessionProjection();
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId: "turn-1", event }), metadata);

  emit(withTs({ type: "tool.started", toolCall: { id: "eval-1", name: "eval", args: { code: "1 + 1" } } }));
  const delta = emit(withTs({ type: "command.output.delta", toolCallId: "eval-1", stream: "stdout", text: "hello\n" }));

  assert.equal(delta[0]?.method, "turn/codeMode/delta");
  assert.equal(delta[0]?.params.itemId, "eval-1");

  const completed = emit(withTs({ type: "turn.completed", runId: "turn-1", sessionId: "fix-auth", assistantMessage: "done" }));
  const items = (completed[0]?.params.turn as { items: Array<{ type: string; tool?: string; liveOutput?: Array<{ text: string }> }> }).items;
  assert.equal(items.length, 1, "the stream must not add a second item");
  assert.equal(items[0]?.type, "dynamicToolCall");
  assert.equal(items[0]?.tool, "eval");
  // The late joiner needs the stream, which the bare delta notifications cannot
  // give it: a client that connects mid-script has missed them all.
  assert.equal(items[0]?.liveOutput?.[0]?.text, "hello\n");
});

test("a delta with no line break appends to the line it belongs to", () => {
  const projection = new SessionProjection();
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId: "turn-1", event }), metadata);

  emit(withTs({ type: "tool.started", toolCall: { id: "eval-1", name: "eval", args: { code: "1 + 1" } } }));
  emit(withTs({ type: "command.output.delta", toolCallId: "eval-1", stream: "stdout", text: "par" }));
  emit(withTs({ type: "command.output.delta", toolCallId: "eval-1", stream: "stdout", text: "tial" }));
  emit(withTs({ type: "command.output.delta", toolCallId: "eval-1", stream: "stdout", text: "\nnext" }));

  const finished = emit(withTs({ type: "turn.completed", runId: "turn-1", sessionId: "fix-auth", assistantMessage: "done" }));
  const items = (finished[0]?.params.turn as { items: Array<{ liveOutput?: Array<{ text: string }> }> }).items;
  const lines = items[0]?.liveOutput ?? [];
  assert.deepEqual(lines.map((line) => line.text), ["partial\nnext"]);
});

test("a delta for a call that does not exist is ignored, not invented", () => {
  const projection = new SessionProjection();
  const emit = (event: ThreadEventRecord["event"]) =>
    projection.project(record({ threadId: "fix-auth", turnId: "turn-1", event }), metadata);

  const notes = emit(withTs({ type: "command.output.delta", toolCallId: "ghost", stream: "stdout", text: "x" }));
  assert.deepEqual(notes, [], "an unknown toolCallId must not create an item out of nothing");
});
